// Módulo de vendas: catálogo, carrinho e pedidos com MongoDB opcional.
import fs from 'node:fs/promises'
import path from 'node:path'
import { MongoClient } from 'mongodb'
const enabled = process.env.VENDAS_ATIVAS !== '0'
const prefix = (process.env.VENDAS_PREFIXO || 'loja').toLowerCase()
const dataPath = process.env.VENDAS_JSON_PATH || './data/vendas.json'
let mongo, collection, cache = { products: [], carts: {}, orders: [] }
let ready
const money = v => (Number(v)/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})
const clean = s => String(s||'').trim()
const qty = s => { const n=Number(s); return Number.isSafeInteger(n)&&n>0&&n<=99?n:null }
const price = s => { const n=Number(String(s).replace(',','.')); return Number.isFinite(n)&&n>0&&n<1000000?Math.round(n*100):null }
const id = () => Math.random().toString(36).slice(2,9).toUpperCase()
async function init(){
  if(process.env.MONGODB_URI){
    mongo = new MongoClient(process.env.MONGODB_URI,{serverSelectionTimeoutMS:6000})
    try { await mongo.connect(); collection=mongo.db(process.env.VENDAS_DB || 'pro_whats_vendas').collection('state'); const doc=await collection.findOne({_id:'store'}); if(doc?.data) cache=doc.data; console.log('🛒 Vendas: MongoDB conectado') }
    catch(e){ console.warn('🛒 MongoDB indisponível:',e.message); await mongo.close().catch(()=>{}); mongo=null }
  }
  if(!collection){ try { cache=JSON.parse(await fs.readFile(dataPath,'utf8')) } catch {} console.warn('🛒 Vendas em arquivo local: use MONGODB_URI para persistência no Render') }
  cache.products ||= []; cache.carts ||= {}; cache.orders ||= []
}
async function save(){ if(collection) await collection.updateOne({_id:'store'},{$set:{data:cache}},{upsert:true}); else {await fs.mkdir(path.dirname(dataPath),{recursive:true}); await fs.writeFile(dataPath,JSON.stringify(cache,null,2))} }
const cartFor = jid => cache.carts[jid] ||= []
const menu = `🛍️ *Bem-vindo à loja!*\n\n*Comandos:*\n• loja produtos — catálogo\n• loja adicionar ID quantidade\n• loja carrinho\n• loja remover ID\n• loja finalizar — gerar pedido\n• loja pedido CÓDIGO — consultar status\n• loja ajuda\n\nPagamento: Pix ou link (confirmação manual).`
function catalog(){return cache.products.length?'🛍️ *Catálogo*\n\n'+cache.products.filter(p=>p.active!==false).map(p=>`*${p.id}* — ${p.name}\n${money(p.price)} | estoque: ${p.stock}\n${p.description||''}`).join('\n\n'):'Ainda não há produtos cadastrados.'}
function summary(jid){const cart=cartFor(jid); if(!cart.length)return '🛒 Carrinho vazio. Envie *loja produtos*.'; let total=0;const rows=cart.map(i=>{const p=cache.products.find(p=>p.id===i.id);if(!p)return '';const sub=p.price*i.quantity;total+=sub;return `${p.name} × ${i.quantity}: ${money(sub)}`});return `🛒 *Seu carrinho*\n${rows.join('\n')}\n\n*Total de produtos: ${money(total)}*\nFrete a combinar com o atendente.\nEnvie *loja finalizar* para fazer o pedido.`}
export async function tratarVendas({texto,jid,isOwner,isGroup,responder}){
 if(!enabled || isGroup || !jid) return false
 const raw=clean(texto), lower=raw.toLowerCase()
 if(!(lower===prefix || lower.startsWith(prefix+' ')))return false
 await (ready ||= init())
 const args=raw.slice(prefix.length).trim().split(/\s+/).filter(Boolean), cmd=(args.shift()||'').toLowerCase()
 let answer=''
 if(!cmd||cmd==='ajuda'||cmd==='menu') answer=menu
 else if(['produtos','catalogo','catálogo'].includes(cmd)) answer=catalog()
 else if(cmd==='adicionar'){
   const p=cache.products.find(p=>p.id.toLowerCase()===(args[0]||'').toLowerCase()&&p.active!==false), n=qty(args[1]||'1')
   if(!p||!n)answer='Use: *loja adicionar ID quantidade*. Confira *loja produtos*.'
   else {const cart=cartFor(jid), item=cart.find(i=>i.id===p.id);const total=(item?.quantity||0)+n;if(total>p.stock)answer=`Estoque disponível: ${p.stock}`;else {if(item)item.quantity=total;else cart.push({id:p.id,quantity:n});await save();answer=`✅ ${p.name} adicionado!\n\n${summary(jid)}`}}
 } else if(cmd==='carrinho')answer=summary(jid)
 else if(cmd==='remover'){const cart=cartFor(jid), before=cart.length;cache.carts[jid]=cart.filter(i=>i.id.toLowerCase()!==(args[0]||'').toLowerCase());await save();answer=before===cache.carts[jid].length?'Produto não está no carrinho.':'✅ Produto removido.'}
 else if(cmd==='finalizar'){
   const cart=cartFor(jid); if(!cart.length)answer='Seu carrinho está vazio.'
   else {let total=0;let valid=true;const items=[];for(const item of cart){const p=cache.products.find(p=>p.id===item.id&&p.active!==false);if(!p||p.stock<item.quantity){valid=false;break}items.push({id:p.id,name:p.name,quantity:item.quantity,unitPrice:p.price});total+=p.price*item.quantity}
    if(!valid)answer='⚠️ Estoque mudou. Revise o carrinho com o atendente antes de finalizar.'
    else {const order={id:id(),jid,items,total,status:'aguardando_pagamento',createdAt:new Date().toISOString()};cache.orders.push(order);delete cache.carts[jid];await save();const pix=clean(process.env.VENDAS_PIX_CHAVE),link=clean(process.env.VENDAS_LINK_PAGAMENTO);answer=`✅ *Pedido #${order.id}*\n${items.map(i=>`${i.name} × ${i.quantity}`).join('\n')}\n*Produtos: ${money(total)}*\n🚚 Frete não incluído; combine endereço e entrega com o atendente.\n\n💳 *Pagamento*\n${pix?'Pix (chave): '+pix+'\n':''}${link?'Link de pagamento: '+link+'\n':''}${!pix&&!link?'Solicite os dados de pagamento ao atendente.\n':''}\n⚠️ Não pague antes de confirmar o valor final com frete. O pedido só será confirmado após verificação do pagamento pelo vendedor.\nConsulte com *loja pedido ${order.id}*`}
   }
 }
 else if(cmd==='pedido'){const o=cache.orders.find(o=>o.id.toLowerCase()===(args[0]||'').toLowerCase()&&(isOwner||o.jid===jid));answer=o?`📦 Pedido #${o.id}\nStatus: ${o.status}\nProdutos: ${money(o.total)} (frete à parte)`: 'Pedido não encontrado.'}
 else if(cmd==='admin'){
   if(!isOwner)answer='🔒 Comando exclusivo do administrador.'
   else {const sub=(args.shift()||'').toLowerCase()
    if(sub==='adicionar'){const [nome,valor,estoque,...descricao]=args;const cents=price(valor),n=Number(estoque);if(!nome||!cents||!Number.isSafeInteger(n)||n<0)answer='Uso: *loja admin adicionar Nome 29,90 10 descrição* (nome sem espaços; use hífen)';else {const p={id:id(),name:nome.replaceAll('-',' '),price:cents,stock:n,description:descricao.join(' '),active:true};cache.products.push(p);await save();answer=`✅ Produto ${p.id} cadastrado.`}}
    else if(sub==='excluir'){const p=cache.products.find(p=>p.id===(args[0]||'').toUpperCase());if(!p)answer='Produto não encontrado.';else {p.active=false;await save();answer='Produto desativado.'}}
    else if(sub==='estoque'){const p=cache.products.find(p=>p.id===(args[0]||'').toUpperCase()),n=Number(args[1]);if(!p||!Number.isSafeInteger(n)||n<0)answer='Uso: loja admin estoque ID quantidade';else {p.stock=n;await save();answer='Estoque atualizado.'}}
    else if(sub==='pedidos')answer=cache.orders.slice(-15).reverse().map(o=>`#${o.id} — ${o.status} — ${money(o.total)}`).join('\n')||'Nenhum pedido.'
    else if(sub==='status'){const o=cache.orders.find(o=>o.id===(args[0]||'').toUpperCase()),status=args[1];const allowed=['aguardando_pagamento','pago','preparando','enviado','entregue','cancelado'];if(!o||!allowed.includes(status))answer=`Uso: loja admin status CODIGO STATUS\n${allowed.join(', ')}`;else {if(status==='pago'&&o.status!=='pago'&&!o.stockDebited){if(o.items.some(i=>(cache.products.find(p=>p.id===i.id)?.stock??0)<i.quantity)){answer='Estoque insuficiente. Corrija antes de confirmar.'}else {for(const i of o.items)cache.products.find(p=>p.id===i.id).stock-=i.quantity;o.stockDebited=true}}if(!answer){o.status=status;await save();answer='Status atualizado. Confirme pagamentos no provedor antes de marcar como pago.'}}}
    else answer='👑 Admin: loja admin adicionar Nome 29,90 10 descrição | excluir ID | estoque ID N | pedidos | status CODIGO STATUS'
   }
 }else answer=menu
 await responder(answer);return true
}
