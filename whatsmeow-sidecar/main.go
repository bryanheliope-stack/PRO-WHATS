// wm-sidecar: serviço whatsmeow (Go) usado como provedor reserva pelo index.js.
// Escuta só em 127.0.0.1:WM_PORT e entrega as mensagens recebidas para WM_NODE_URL/_wm/evento.
package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
	_ "modernc.org/sqlite"
)

var (
	secret  = os.Getenv("WM_SECRET")
	nodeURL = os.Getenv("WM_NODE_URL")
	phone   = os.Getenv("WM_PHONE")
	mode    = os.Getenv("WM_MODE")
	dbURL   = os.Getenv("WM_DB")
	port    = envOr("WM_PORT", "8081")

	client *whatsmeow.Client

	mu       sync.Mutex
	status   = "iniciando"
	codigo   string
	codigoEm int64
	qr       string
	pareado  bool
	httpCli  = &http.Client{Timeout: 10 * time.Second}
)

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func setStatus(s string) {
	mu.Lock()
	status = s
	mu.Unlock()
}

func autorizado(r *http.Request) bool {
	return secret != "" && subtle.ConstantTimeCompare([]byte(r.Header.Get("x-wm-secret")), []byte(secret)) == 1
}

func escreverJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

// ---------- eventos ----------

type eventoMsg struct {
	Tipo      string `json:"tipo"`
	Chat      string `json:"chat"`
	Sender    string `json:"sender"`
	SenderAlt string `json:"senderAlt,omitempty"`
	IsGroup   bool   `json:"isGroup"`
	FromMe    bool   `json:"fromMe"`
	ID        string `json:"id"`
	Text      string `json:"text"`
	Ts        int64  `json:"ts"`
	Gif       bool   `json:"gif"`
}

func enviarParaNode(m eventoMsg) {
	corpo, _ := json.Marshal(m)
	req, _ := http.NewRequest("POST", nodeURL+"/_wm/evento", bytes.NewReader(corpo))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-wm-secret", secret)
	resp, err := httpCli.Do(req)
	if err != nil {
		log.Printf("erro ao entregar mensagem ao Node: %v", err)
		return
	}
	resp.Body.Close()
}

func tratarEvento(evt any) {
	switch v := evt.(type) {
	case *events.Connected:
		mu.Lock()
		status, codigo, qr, pareado = "conectado", "", "", true
		mu.Unlock()
		log.Println("conectado")
	case *events.Disconnected:
		mu.Lock()
		if status == "conectado" {
			status = "reconectando"
		}
		mu.Unlock()
	case *events.PairSuccess:
		mu.Lock()
		pareado, codigo, qr = true, "", ""
		mu.Unlock()
		log.Printf("pareamento aceito: %s", v.ID)
	case *events.LoggedOut:
		setStatus("deslogado")
		log.Println("aparelho desvinculado")
	case *events.StreamReplaced:
		setStatus("substituido")
		log.Println("sessão aberta em outro lugar")
	case *events.Message:
		m := v.Message
		if m == nil {
			return
		}
		texto := m.GetConversation()
		if texto == "" {
			texto = m.GetExtendedTextMessage().GetText()
		}
		gif := m.GetVideoMessage().GetGifPlayback()
		if texto == "" && !gif {
			return
		}
		ev := eventoMsg{
			Tipo:    "mensagem",
			Chat:    v.Info.Chat.String(),
			Sender:  v.Info.Sender.String(),
			IsGroup: v.Info.IsGroup,
			FromMe:  v.Info.IsFromMe,
			ID:      v.Info.ID,
			Text:    texto,
			Ts:      v.Info.Timestamp.Unix(),
			Gif:     gif,
		}
		if !v.Info.SenderAlt.IsEmpty() {
			ev.SenderAlt = v.Info.SenderAlt.String()
		}
		go enviarParaNode(ev)
	}
}

// ---------- pareamento ----------

func parear(ctx context.Context) {
	if mode == "qr" || phone == "" {
		ch, err := client.GetQRChannel(ctx)
		if err != nil {
			log.Printf("QR: %v", err)
		} else {
			go func() {
				for item := range ch {
					mu.Lock()
					if item.Event == "code" {
						qr = item.Code
						status = "aguardando_qr"
					} else {
						qr = ""
					}
					mu.Unlock()
				}
			}()
		}
		if err := client.Connect(); err != nil {
			log.Fatalf("connect: %v", err)
		}
		return
	}

	if err := client.Connect(); err != nil {
		log.Fatalf("connect: %v", err)
	}
	// O WhatsApp precisa terminar o handshake antes de aceitar o pedido de código
	time.Sleep(3 * time.Second)
	for {
		c, err := client.PairPhone(ctx, phone, true, whatsmeow.PairClientChrome, "Chrome (Linux)")
		if err == nil {
			mu.Lock()
			codigo, codigoEm, status = c, time.Now().UnixMilli(), "aguardando_codigo"
			mu.Unlock()
			log.Printf("código de pareamento gerado: %s", c)
			return
		}
		if strings.Contains(err.Error(), "429") || strings.Contains(err.Error(), "rate-overlimit") {
			// O WhatsApp limita pedidos de código por número. Insistir só prolonga o bloqueio: espera bastante.
			setStatus("limite_whatsapp")
			log.Printf("WhatsApp limitou os pedidos de código (429). Nova tentativa em 20 min. Use o modo QR para parear agora.")
			select {
			case <-time.After(20 * time.Minute):
				continue
			case <-ctx.Done():
				return
			}
		}
		log.Fatalf("PairPhone: %v", err) // outro erro: o Node reinicia o serviço
	}
}

// ---------- HTTP ----------

func main() {
	if secret == "" || nodeURL == "" {
		log.Fatal("WM_SECRET e WM_NODE_URL são obrigatórios")
	}
	if dbURL == "" {
		dbURL = "file:sessao.db"
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Postgres (WM_DATABASE_URL) mantém a sessão entre deploys; SQLite fica no disco local.
	// Abre o banco aqui e entrega ao sqlstore, sem depender do nome do driver.
	var db *sql.DB
	var dialeto string
	var err error
	if strings.HasPrefix(dbURL, "postgres://") || strings.HasPrefix(dbURL, "postgresql://") {
		dialeto = "postgres"
		db, err = sql.Open("pgx", dbURL)
	} else {
		dialeto = "sqlite3"
		if !strings.Contains(dbURL, "?") {
			dbURL += "?_pragma=foreign_keys(1)&_pragma=busy_timeout(10000)"
		}
		db, err = sql.Open("sqlite", dbURL)
		if err == nil {
			db.SetMaxOpenConns(1)
		}
	}
	if err != nil {
		log.Fatalf("banco: %v", err)
	}

	dbLog := waLog.Stdout("DB", "WARN", false)
	container := sqlstore.NewWithDB(db, dialeto, dbLog)
	if err := container.Upgrade(ctx); err != nil {
		log.Fatalf("banco (migração): %v", err)
	}
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		log.Fatalf("dispositivo: %v", err)
	}
	client = whatsmeow.NewClient(device, waLog.Stdout("WM", "WARN", false))
	client.AddEventHandler(tratarEvento)

	mu.Lock()
	pareado = client.Store.ID != nil
	mu.Unlock()

	mux := http.NewServeMux()
	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		if !autorizado(r) {
			w.WriteHeader(404)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		escreverJSON(w, 200, map[string]any{
			"status": status, "codigo": codigo, "codigoEm": codigoEm, "qr": qr, "pareado": pareado,
		})
	})
	mux.HandleFunc("/send", func(w http.ResponseWriter, r *http.Request) {
		if !autorizado(r) || r.Method != http.MethodPost {
			w.WriteHeader(404)
			return
		}
		var req struct {
			To          string `json:"to"`
			Text        string `json:"text"`
			ReplyID     string `json:"reply_id"`
			ReplySender string `json:"reply_sender"`
			ReplyText   string `json:"reply_text"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
			escreverJSON(w, 400, map[string]string{"erro": "json inválido"})
			return
		}
		to, err := types.ParseJID(req.To)
		if err != nil {
			escreverJSON(w, 400, map[string]string{"erro": "destino inválido"})
			return
		}
		var msg *waE2E.Message
		if req.ReplyID != "" {
			ci := &waE2E.ContextInfo{
				StanzaID:      proto.String(req.ReplyID),
				QuotedMessage: &waE2E.Message{Conversation: proto.String(req.ReplyText)},
			}
			if req.ReplySender != "" {
				ci.Participant = proto.String(req.ReplySender)
			}
			msg = &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String(req.Text), ContextInfo: ci}}
		} else {
			msg = &waE2E.Message{Conversation: proto.String(req.Text)}
		}
		sctx, scancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer scancel()
		_ = client.SendChatPresence(sctx, to, types.ChatPresenceComposing, types.ChatPresenceMediaText)
		resp, err := client.SendMessage(sctx, to, msg)
		if err != nil {
			escreverJSON(w, 502, map[string]string{"erro": err.Error()})
			return
		}
		escreverJSON(w, 200, map[string]any{"ok": true, "id": resp.ID})
	})

	srv := &http.Server{Addr: "127.0.0.1:" + port, Handler: mux}
	go func() {
		log.Printf("ouvindo em %s", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http: %v", err)
		}
	}()

	if client.Store.ID == nil {
		go parear(ctx)
	} else {
		setStatus("conectando")
		if err := client.Connect(); err != nil {
			log.Fatalf("connect: %v", err)
		}
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	<-sig
	fmt.Println("encerrando")
	client.Disconnect()
	srv.Shutdown(context.Background())
}
