// wm-sidecar: serviço auxiliar (whatsmeow) usado como RESERVA do Baileys.
// O index.js (Node) inicia este processo, recebe as mensagens por webhook local
// e envia as respostas por HTTP local. Escuta só em 127.0.0.1.
package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"
	"google.golang.org/protobuf/proto"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
)

func env(nome, padrao string) string {
	if v := strings.TrimSpace(os.Getenv(nome)); v != "" {
		return v
	}
	return padrao
}

var (
	cfgSecret  = env("WM_SECRET", "")
	cfgNodeURL = env("WM_NODE_URL", "http://127.0.0.1:10000")
	cfgPhone   = env("WM_PHONE", "")
	cfgMode    = env("WM_MODE", "codigo") // "codigo" ou "qr"
	cfgPort    = env("WM_PORT", "8081")
	cfgDB      = env("WM_DB", "file:sessao.db")

	client  *whatsmeow.Client
	st      = &estado{Status: "iniciando"}
	httpCli = &http.Client{Timeout: 10 * time.Second}
	connMu  sync.Mutex
)

// ---------- estado compartilhado (lido pelo Node em /status) ----------

type estado struct {
	mu        sync.Mutex
	Status    string `json:"status"` // iniciando | aguardando_pareamento | conectado | desconectado | deslogado | substituido | erro
	Conectado bool   `json:"conectado"`
	Pareado   bool   `json:"pareado"`
	Codigo    string `json:"codigo"`
	CodigoEm  int64  `json:"codigoEm"`
	QR        string `json:"qr"`
}

func (e *estado) mudar(f func(*estado)) {
	e.mu.Lock()
	defer e.mu.Unlock()
	f(e)
}

func (e *estado) snapshot() []byte {
	e.mu.Lock()
	defer e.mu.Unlock()
	b, _ := json.Marshal(e)
	return b
}

// ---------- webhook para o Node ----------

func notificar(payload map[string]any) {
	b, err := json.Marshal(payload)
	if err != nil {
		return
	}
	for tentativa := 1; tentativa <= 2; tentativa++ {
		req, _ := http.NewRequest(http.MethodPost, cfgNodeURL+"/_wm/evento", bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("x-wm-secret", cfgSecret)
		resp, err := httpCli.Do(req)
		if err == nil {
			resp.Body.Close()
			return
		}
		log.Printf("webhook para o Node falhou (tentativa %d): %v", tentativa, err)
		time.Sleep(500 * time.Millisecond)
	}
}

// ---------- mensagens recebidas ----------

func tratarMensagem(v *events.Message) {
	if v.Info.IsFromMe {
		return
	}
	srv := v.Info.Chat.Server
	if srv == "broadcast" || srv == "newsletter" {
		return
	}
	texto := v.Message.GetConversation()
	if texto == "" {
		texto = v.Message.GetExtendedTextMessage().GetText()
	}
	alt := ""
	if !v.Info.SenderAlt.IsEmpty() {
		alt = v.Info.SenderAlt.ToNonAD().String()
	}
	notificar(map[string]any{
		"tipo":      "mensagem",
		"id":        v.Info.ID,
		"chat":      v.Info.Chat.ToNonAD().String(),
		"sender":    v.Info.Sender.ToNonAD().String(),
		"senderAlt": alt,
		"fromMe":    v.Info.IsFromMe,
		"isGroup":   v.Info.IsGroup,
		"text":      texto,
		"ts":        v.Info.Timestamp.Unix(),
		"gif":       v.Message.GetVideoMessage().GetGifPlayback(),
		"push":      v.Info.PushName,
	})
}

func handler(evt interface{}) {
	switch v := evt.(type) {
	case *events.Connected:
		log.Println("conectado ao WhatsApp")
		st.mudar(func(e *estado) {
			e.Status, e.Conectado, e.Pareado = "conectado", true, true
			e.Codigo, e.QR = "", ""
		})
	case *events.Disconnected:
		log.Println("desconectado (reconexão automática ligada)")
		st.mudar(func(e *estado) {
			if e.Status == "conectado" {
				e.Status = "desconectado"
			}
			e.Conectado = false
		})
	case *events.LoggedOut:
		log.Printf("aparelho desvinculado pelo celular: %+v", v.Reason)
		st.mudar(func(e *estado) { e.Status, e.Conectado, e.Pareado = "deslogado", false, false })
	case *events.StreamReplaced:
		log.Println("sessão aberta em outro lugar (stream replaced)")
		st.mudar(func(e *estado) { e.Status, e.Conectado = "substituido", false })
	case *events.PairSuccess:
		log.Printf("pareamento aceito: %s", v.ID.String())
		st.mudar(func(e *estado) { e.Pareado = true; e.Codigo, e.QR = "", "" })
	case *events.Message:
		go tratarMensagem(v)
	}
}

// ---------- pareamento e conexão ----------

func pedirCodigo() {
	for tentativa := 1; tentativa <= 5; tentativa++ {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		codigo, err := client.PairPhone(ctx, cfgPhone, true, whatsmeow.PairClientChrome, "Chrome (Linux)")
		cancel()
		if err == nil {
			log.Printf("código de pareamento gerado: %s", codigo)
			st.mudar(func(e *estado) {
				e.Codigo, e.CodigoEm, e.QR, e.Status = codigo, time.Now().UnixMilli(), "", "aguardando_pareamento"
			})
			return
		}
		log.Printf("erro ao gerar código (tentativa %d/5): %v", tentativa, err)
		time.Sleep(time.Duration(tentativa) * 2 * time.Second)
	}
	st.mudar(func(e *estado) { e.Status = "erro" })
}

func conectar() {
	connMu.Lock()
	defer connMu.Unlock()
	if client.IsConnected() {
		client.Disconnect()
	}
	// Já pareado: só conecta
	if client.Store.ID != nil {
		if err := client.Connect(); err != nil {
			log.Printf("erro ao conectar: %v", err)
			st.mudar(func(e *estado) { e.Status = "erro" })
		}
		return
	}
	// Ainda não pareado: QR / código de telefone
	qrChan, err := client.GetQRChannel(context.Background())
	if err != nil {
		log.Printf("erro ao abrir canal de QR: %v", err)
		st.mudar(func(e *estado) { e.Status = "erro" })
		return
	}
	if err := client.Connect(); err != nil {
		log.Printf("erro ao conectar para parear: %v", err)
		st.mudar(func(e *estado) { e.Status = "erro" })
		return
	}
	go func() {
		pediu := false
		for item := range qrChan {
			switch item.Event {
			case "code":
				if cfgMode == "qr" || cfgPhone == "" {
					st.mudar(func(e *estado) { e.QR, e.Status = item.Code, "aguardando_pareamento" })
				} else if !pediu {
					pediu = true
					go pedirCodigo()
				}
			case "timeout":
				log.Println("tempo de pareamento esgotado — gerando novo código/QR")
				st.mudar(func(e *estado) { e.Codigo, e.QR = "", "" })
				go func() {
					time.Sleep(time.Second)
					conectar()
				}()
			case "success":
				log.Println("pareamento concluído")
			}
		}
	}()
}

// ---------- API HTTP local ----------

func autorizado(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if cfgSecret == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("x-wm-secret")), []byte(cfgSecret)) != 1 {
			responder(w, http.StatusUnauthorized, map[string]any{"erro": "não autorizado"})
			return
		}
		h(w, r)
	}
}

func responder(w http.ResponseWriter, codigo int, corpo any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(codigo)
	_ = json.NewEncoder(w).Encode(corpo)
}

func parseJID(s string) (types.JID, error) {
	if !strings.Contains(s, "@") {
		s += "@s.whatsapp.net"
	}
	return types.ParseJID(s)
}

type envio struct {
	To          string `json:"to"`
	Text        string `json:"text"`
	ReplyID     string `json:"reply_id"`
	ReplySender string `json:"reply_sender"`
	ReplyText   string `json:"reply_text"`
}

func rotaEnviar(w http.ResponseWriter, r *http.Request) {
	var e envio
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&e); err != nil || e.To == "" || strings.TrimSpace(e.Text) == "" {
		responder(w, http.StatusBadRequest, map[string]any{"erro": "parâmetros inválidos"})
		return
	}
	if !client.IsConnected() || !client.IsLoggedIn() {
		responder(w, http.StatusServiceUnavailable, map[string]any{"erro": "WhatsApp desconectado"})
		return
	}
	jid, err := parseJID(e.To)
	if err != nil {
		responder(w, http.StatusBadRequest, map[string]any{"erro": "destino inválido"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	_ = client.SendChatPresence(ctx, jid, types.ChatPresenceComposing, types.ChatPresenceMediaText)

	msg := &waE2E.Message{Conversation: proto.String(e.Text)}
	if e.ReplyID != "" {
		msg = &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{
			Text: proto.String(e.Text),
			ContextInfo: &waE2E.ContextInfo{
				StanzaID:      proto.String(e.ReplyID),
				Participant:   proto.String(e.ReplySender),
				QuotedMessage: &waE2E.Message{Conversation: proto.String(e.ReplyText)},
			},
		}}
	}
	resp, err := client.SendMessage(ctx, jid, msg)
	_ = client.SendChatPresence(ctx, jid, types.ChatPresencePaused, types.ChatPresenceMediaText)
	if err != nil {
		responder(w, http.StatusBadGateway, map[string]any{"erro": err.Error()})
		return
	}
	responder(w, http.StatusOK, map[string]any{"ok": true, "id": resp.ID})
}

// ---------- main ----------

func abrirBanco() (*sql.DB, string) {
	if strings.HasPrefix(cfgDB, "postgres://") || strings.HasPrefix(cfgDB, "postgresql://") {
		db, err := sql.Open("pgx", cfgDB)
		if err != nil {
			log.Fatalf("erro ao abrir Postgres: %v", err)
		}
		return db, "postgres"
	}
	dsn := cfgDB
	if !strings.Contains(dsn, "?") {
		dsn += "?_pragma=foreign_keys(1)&_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)"
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		log.Fatalf("erro ao abrir SQLite: %v", err)
	}
	db.SetMaxOpenConns(1) // SQLite: uma conexão evita "database is locked"
	return db, "sqlite3"
}

func main() {
	log.SetFlags(log.LstdFlags)
	if cfgSecret == "" {
		log.Fatal("WM_SECRET não definido")
	}
	ctx := context.Background()

	db, dialeto := abrirBanco()
	container := sqlstore.NewWithDB(db, dialeto, waLog.Stdout("DB", "WARN", false))
	if err := container.Upgrade(ctx); err != nil {
		log.Fatalf("erro ao preparar o banco: %v", err)
	}
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		log.Fatalf("erro ao carregar o dispositivo: %v", err)
	}
	client = whatsmeow.NewClient(device, waLog.Stdout("WM", "WARN", false))
	client.AddEventHandler(handler)
	st.mudar(func(e *estado) { e.Pareado = client.Store.ID != nil })

	mux := http.NewServeMux()
	mux.HandleFunc("/status", autorizado(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(st.snapshot())
	}))
	mux.HandleFunc("/send", autorizado(rotaEnviar))
	srv := &http.Server{Addr: "127.0.0.1:" + cfgPort, Handler: mux}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("erro no servidor HTTP: %v", err)
		}
	}()

	go conectar()

	encerrar := func() {
		log.Println("encerrando...")
		client.Disconnect()
		c, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(c)
		os.Exit(0)
	}
	// Se o Node morrer, o stdin fecha e este processo sai junto (não fica órfão)
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		encerrar()
	}()
	sinais := make(chan os.Signal, 1)
	signal.Notify(sinais, syscall.SIGTERM, syscall.SIGINT)
	<-sinais
	encerrar()
}
