// ======================================
// 📋 COMANDOS — COM SISTEMA DE DONO
// ======================================
async function processCommand(text, userId, grupoId, quotedText = '') {
  const cmd = text.toLowerCase().replace(new RegExp(TRIGGER_LOWER, 'gi'), '').trim()
  const parts = cmd.split(/\s+/)
  const acao = parts[0]
  const resto = parts.slice(1).join(' ').trim()

  // 🔒 O NÚMERO DO DONO — CONFIGURE AQUI!
  const DONO_NUMERO = onlyDigits(PHONE_NUMBER || '') // ✅ Usa o número que conectou o bot

  // ✅ Verificar se é o dono
  const ehDono = [...brVariants(userId)].some(v => DONO_NUMERO && DONO_NUMERO.includes(v))

  let resposta = ''

  switch (acao) {
    // ✅ Todos podem ensinar/corrigir
    case 'corrija':
    case 'aprenda':
    case 'lembre':
      let assunto, respostaCorreta
      if (resto.includes('=') || resto.includes('é') || resto.includes(':')) {
        const separador = resto.includes('=') ? '=' : resto.includes(':') ? ':' : 'é'
        const separado = resto.split(new RegExp(` ${separador} `), 2)
        assunto = separado[0]?.trim()
        respostaCorreta = separado[1]?.trim()
      }
      if (!respostaCorreta && quotedText) {
        assunto = resto || 'essa informação'
        respostaCorreta = quotedText
      }
      if (!assunto || !respostaCorreta) {
        return `📝 **Como me corrigir:**

• ${TRIGGER} corrija [o que] = [resposta certa]
• Ou me cite uma mensagem e diga: "${TRIGGER} não, é assim!"`
      }
      await Memory.saveCorrection(userId, grupoId, assunto, '', respostaCorreta)
      return `✅ **Anotado! Obrigado por ensinar!** 🧠

📌 ${assunto}
✅ ${respostaCorreta}`

    // ✅ Todos podem ver a memória
    case 'memoria':
    case 'lembrancas':
    case 'aprendizado':
      const correcoes = await Memory.listAll(userId, grupoId)
      return correcoes.length === 0
        ? `📚 Ainda não aprendi nada! Quando eu errar, me corrija usando:\n${TRIGGER} corrija isso = resposta certa`
        : `📚 **O que aprendi com todos (${correcoes.length}):**

${correcoes.map((c, i) => `${i + 1}. ❓ ${c.assunto}\n   ✅ ${c.respostaCorreta}`).join('\n\n')}`

    // ✅ Todos podem ver estatísticas
    case 'estatisticas':
    case 'stats':
      const hoje = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      const logs = dbLogs ? await dbLogs.find({ tipo: 'auto-analise', data: { $gte: hoje } }).sort({ data: -1 }).limit(7).toArray() : []
      return `📊 **Estatísticas dos últimos 7 dias:**

${logs.length === 0 ? 'Sem dados ainda. A auto-análise roda diariamente.' 
  : logs.map(l => `📅 ${l.data.toLocaleDateString('pt-BR')}: ${l.totalConversas} msgs, ${l.corrigidas} correções (${l.taxaCorrecao}%)`).join('\n')}

🔄 Auto-análise: às ${AUTO_IMPROVEMENT_HOUR}h`

    // 🔒 APENAS O DONO PODE APAGAR
    case 'esquece':
    case 'esqueça':
    case 'apague':
      if (!ehDono) {
        return '🔒 Apenas o dono do bot pode apagar a memória.'
      }
      if (!resto || resto === 'tudo') {
        if (resto === 'tudo') {
          await Memory.clearAll(userId, grupoId)
          return '🗑️ **Pronto! Memória apagada com sucesso!** ✅'
        }
        return `Uso: ${TRIGGER} esquece [assunto]\nOu: ${TRIGGER} esquece tudo`
      }
      await Memory.delete(userId, grupoId, resto)
      return `🗑️ Esqueci: "${resto}" ✅`

    // 🔒 Comandos de administração extras
    case 'dono':
    case 'admin':
      return ehDono
        ? `👑 Você é o DONO do bot! Comandos exclusivos:

• ${TRIGGER} esquece [assunto] → Apaga uma correção
• ${TRIGGER} esquece tudo → Limpa memória completa

Ninguém mais pode alterar ou apagar! ✅`
        : '🔒 Apenas o dono tem acesso a esses comandos.'

    case 'ajuda':
    default:
      return `🧠 **Nexos — IA Comunitária**

✨ **Comandos para todos:**
• ${TRIGGER} [sua pergunta] → Falar comigo
• ${TRIGGER} corrija [o que] = [resposta] → Me ensinar
• ${TRIGGER} memoria → Ver o que aprendi
• ${TRIGGER} estatisticas → Ver evolução

👑 **Apenas o dono:**
• ${TRIGGER} esquece [assunto] → Apagar uma correção
• ${TRIGGER} esquece tudo → Limpar tudo

💡 Todos podem ensinar, só você controla! 😊`
  }
}
