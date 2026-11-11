import initSqlJs, {type Database} from 'sql.js'
// @ts-ignore

import {newId,todayISO} from '../utils/format'
import type {Product,Marketplace,Transaction,FixedBill,Goal,Budget,BillPayment,Recurrence,Category,Investment,InvestmentTransaction,CreditCard,CreditCardPurchase,CreditCardPayment} from '../types'
let sql:any=null; let DB:Database|null=null; const KEY='precifica.db.base64'
async function init(){
 if(DB) return DB
 sql=await initSqlJs({locateFile:()=>'/sql-wasm-browser.wasm'})
 const saved=localStorage.getItem(KEY)
 if(saved){ const bin=Uint8Array.from(atob(saved),c=>c.charCodeAt(0)); DB=new sql.Database(bin) }
 else DB=new sql.Database()
 migrate()
 return DB
}
function migrate(){
 const db=DB!; db.run('PRAGMA foreign_keys=ON;')
 db.run(`CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,name TEXT NOT NULL,cost REAL,freight REAL,packaging REAL,other_costs REAL,category TEXT,sale_price REAL,desired_margin REAL,marketplace TEXT,created_at TEXT,updated_at TEXT);
 CREATE TABLE IF NOT EXISTS marketplaces(id TEXT PRIMARY KEY,name TEXT UNIQUE,commission REAL,payment REAL,fixed REAL,tax REAL,is_default INTEGER,note TEXT,created_at TEXT);
 CREATE TABLE IF NOT EXISTS pricing_simulations(id TEXT PRIMARY KEY,product_id TEXT,payload TEXT,created_at TEXT);
 CREATE TABLE IF NOT EXISTS pricing_history(id TEXT PRIMARY KEY,product_id TEXT,price REAL,created_at TEXT);
 CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY,value TEXT);`)
 db.run(`CREATE INDEX IF NOT EXISTS idx_products_category ON products(category); CREATE INDEX IF NOT EXISTS idx_products_created ON products(created_at);
 CREATE TABLE IF NOT EXISTS transactions(id TEXT PRIMARY KEY,description TEXT NOT NULL,amount REAL,type TEXT,category TEXT,date TEXT,note TEXT,created_at TEXT);
 CREATE TABLE IF NOT EXISTS fixed_bills(id TEXT PRIMARY KEY,name TEXT NOT NULL,amount REAL,due_day INTEGER,category TEXT,created_at TEXT);
 CREATE TABLE IF NOT EXISTS goals(id TEXT PRIMARY KEY,name TEXT NOT NULL,target REAL,saved REAL,deadline TEXT,created_at TEXT);
 CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date); CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(type);
 CREATE TABLE IF NOT EXISTS budgets(category TEXT NOT NULL,"limit" REAL,user_id TEXT,PRIMARY KEY(user_id,category));
 CREATE TABLE IF NOT EXISTS bill_payments(bill_id TEXT,month TEXT,paid_at TEXT,PRIMARY KEY(bill_id,month));
 CREATE TABLE IF NOT EXISTS recurrences(id TEXT PRIMARY KEY,description TEXT,amount REAL,type TEXT,category TEXT,day INTEGER,active INTEGER,created_at TEXT);
 CREATE TABLE IF NOT EXISTS recurrence_launches(recurrence_id TEXT,month TEXT,PRIMARY KEY(recurrence_id,month));
 CREATE TABLE IF NOT EXISTS categories(name TEXT,type TEXT,user_id TEXT,PRIMARY KEY(user_id,name,type));
 CREATE TABLE IF NOT EXISTS goal_auto_launches(goal_id TEXT,month TEXT,PRIMARY KEY(goal_id,month));
 CREATE TABLE IF NOT EXISTS investments(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,category TEXT,ticker TEXT,institution TEXT,quantity REAL,average_price REAL,invested_amount REAL,current_value REAL,started_at TEXT,notes TEXT,created_at TEXT,updated_at TEXT);
 CREATE TABLE IF NOT EXISTS investment_transactions(id TEXT PRIMARY KEY,investment_id TEXT NOT NULL,user_id TEXT NOT NULL,type TEXT,quantity REAL,unit_price REAL,amount REAL,date TEXT,description TEXT,created_at TEXT);
 CREATE INDEX IF NOT EXISTS idx_inv_user ON investments(user_id); CREATE INDEX IF NOT EXISTS idx_itx_inv ON investment_transactions(investment_id); CREATE INDEX IF NOT EXISTS idx_itx_user ON investment_transactions(user_id);
 CREATE TABLE IF NOT EXISTS credit_cards(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,brand TEXT,limit_amount REAL,closing_day INTEGER,due_day INTEGER,color TEXT,created_at TEXT,updated_at TEXT);
 CREATE TABLE IF NOT EXISTS credit_card_purchases(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,card_id TEXT NOT NULL,description TEXT NOT NULL,category TEXT,total_amount REAL,installments INTEGER,first_date TEXT,notes TEXT,created_at TEXT,updated_at TEXT);
 CREATE TABLE IF NOT EXISTS credit_card_payments(card_id TEXT,month TEXT,paid_at TEXT,user_id TEXT,PRIMARY KEY(card_id,month));
 CREATE INDEX IF NOT EXISTS idx_cc_user ON credit_cards(user_id); CREATE INDEX IF NOT EXISTS idx_ccp_card ON credit_card_purchases(card_id); CREATE INDEX IF NOT EXISTS idx_ccp_user ON credit_card_purchases(user_id);
 CREATE TABLE IF NOT EXISTS sync_queue(op_id TEXT PRIMARY KEY,entity TEXT,user_id TEXT,record_id TEXT,op TEXT,payload TEXT,base_version INTEGER,attempts INTEGER,next_retry_at TEXT,created_at TEXT);
 CREATE TABLE IF NOT EXISTS sync_meta(entity TEXT,user_id TEXT,record_id TEXT,hash TEXT,version INTEGER,PRIMARY KEY(entity,user_id,record_id));
 CREATE TABLE IF NOT EXISTS sync_state(entity TEXT PRIMARY KEY,last_pulled_at TEXT,last_sync_at TEXT);
 CREATE TABLE IF NOT EXISTS sync_conflicts(id TEXT PRIMARY KEY,entity TEXT,user_id TEXT,record_id TEXT,local TEXT,remote TEXT,local_version INTEGER,remote_version INTEGER,created_at TEXT,resolved_at TEXT);`)
 for (const tbl of ['transactions','fixed_bills','goals','budgets','bill_payments','recurrences','recurrence_launches','categories','goal_auto_launches']) {
   const cols=db.exec(`PRAGMA table_info(${tbl})`)[0]?.values.map((v:any)=>String(v[1]))||[]
   if(cols.length && !cols.includes('user_id')) db.run(`ALTER TABLE ${tbl} ADD COLUMN user_id TEXT`)
 }
 // Migração: PK antiga (só categoria/nome) não isola contas no mesmo aparelho. Reconstrói com user_id na PK.
 const tableSql=(t:string)=>String(db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name=?",[t])[0]?.values[0]?.[0]||'').replace(/\s+/g,'').toUpperCase()
 if(tableSql('budgets') && !tableSql('budgets').includes('PRIMARYKEY(USER_ID,CATEGORY)')){
   db.run('CREATE TABLE budgets_new(category TEXT NOT NULL,"limit" REAL,user_id TEXT,PRIMARY KEY(user_id,category))')
   db.run("INSERT OR REPLACE INTO budgets_new(category,\"limit\",user_id) SELECT category,\"limit\",COALESCE(user_id,'') FROM budgets")
   db.run('DROP TABLE budgets'); db.run('ALTER TABLE budgets_new RENAME TO budgets')
 }
 if(tableSql('categories') && !tableSql('categories').includes('PRIMARYKEY(USER_ID,NAME,TYPE)')){
   db.run('CREATE TABLE categories_new(name TEXT,type TEXT,user_id TEXT,PRIMARY KEY(user_id,name,type))')
   db.run("INSERT OR REPLACE INTO categories_new(name,type,user_id) SELECT name,type,COALESCE(user_id,'') FROM categories")
   db.run('DROP TABLE categories'); db.run('ALTER TABLE categories_new RENAME TO categories')
 }
 const goalCols=db.exec('PRAGMA table_info(goals)')[0]?.values.map((v:any)=>String(v[1]))||[]
 if(goalCols.length && !goalCols.includes('auto_monthly')){ db.run('ALTER TABLE goals ADD COLUMN auto_monthly REAL DEFAULT 0') }
 const itxCols=db.exec('PRAGMA table_info(investment_transactions)')[0]?.values.map((v:any)=>String(v[1]))||[]
 if(itxCols.length && !itxCols.includes('cost_removed')){ db.run('ALTER TABLE investment_transactions ADD COLUMN cost_removed REAL DEFAULT 0') }
 if(itxCols.length && !itxCols.includes('realized_gain')){ db.run('ALTER TABLE investment_transactions ADD COLUMN realized_gain REAL DEFAULT 0') }
 const cc=db.exec('SELECT COUNT(*) v FROM categories')[0]?.values[0][0]
 if(!cc){ const seed:[string,string][]=[...['Moradia','Alimentação','Transporte','Contas da casa','Lazer','Saúde','Educação','Compras','Assinaturas','Outros'].map(n=>[n,'out'] as [string,string]),...['Salário','Trabalho extra','Venda','Presente','Reembolso','Outros'].map(n=>[n,'in'] as [string,string])]; const st=db.prepare('INSERT OR IGNORE INTO categories(name,type) VALUES(?,?)'); seed.forEach(r=>st.run(r)); st.free() }
 const c=db.exec('SELECT COUNT(*) v FROM marketplaces')[0].values[0][0]
 if(c===0){
  const id=newId(),now=todayISO()
  const rows:[string,string,number,number,number,number,number,string,string][]=[
   [id,'Venda direta',0,0,0,0,1,'Configure suas taxas reais. Editável.','2025-01-01T00:00:00.000Z'],
   [newId(),'Shopee (editável)',0,0,0,0,0,'Taxas variam por categoria/anúncio. Confirme na plataforma. '+now,now],
   [newId(),'Mercado Livre (editável)',0,0,0,0,0,'Taxas variam. Confirme na plataforma.',now],
   [newId(),'Amazon (editável)',0,0,0,0,0,'Taxas variam por categoria. Confirme na plataforma.',now],
  ]
  const stmt=db.prepare('INSERT OR IGNORE INTO marketplaces VALUES(?,?,?,?,?,?,?,?,?)')
  rows.forEach(r=>stmt.run([r[0],r[1],r[2],r[3],r[4],r[5],r[6],r[7],r[8]])); stmt.free()
 }
 // Migração legada de custo (uma vez): reconstrói custo remanescente via replay das movimentações
 // somente quando o histórico é coerente (quantidade final confere); senão mantém o valor atual.
 try {
  const flag=db.exec("SELECT value FROM app_settings WHERE key='legacy_cost_migrated'")[0]?.values[0]?.[0]
  if(!flag){
   const invs=db.exec('SELECT id,quantity,average_price,invested_amount FROM investments')[0]?.values||[]
   for(const iv of invs){
    const txs=db.exec('SELECT type,quantity,unit_price,amount,date,id FROM investment_transactions WHERE investment_id=? ORDER BY date ASC',[iv[0]])[0]?.values||[]
    if(!txs.length) continue
    let q=0, avg=Number(iv[2]||0), cost=0, coherent=true
    const computed:{id:string,cost:number,real:number}[]=[]
    for(const tx of txs){
     const type=String(tx[1]), qty=Number(tx[2]||0), up=Number(tx[3]||0), amt=Number(tx[4]||0)
     if(type==='compra'||type==='aporte'){ const nq=q+qty; avg=nq>0&&qty>0?(q*avg+qty*up)/nq:(up||avg); q=nq; cost+=amt }
     else if(type==='venda'||type==='resgate'){ if(qty>0&&q>0&&qty>q+1e-9){ coherent=false; break } const cr=qty>0?qty*avg:Math.min(cost,amt); cost=Math.max(0,cost-cr); q=Math.max(0,q-qty); computed.push({id:String(tx[5]),cost:Math.round(cr*100)/100,real:Math.round((amt-cr)*100)/100}) }
    }
    if(!coherent||Math.abs(q-Number(iv[1]||0))>0.0001) continue
    for(const c of computed) db.run('UPDATE investment_transactions SET cost_removed=?, realized_gain=? WHERE id=?',[c.cost,c.real,c.id])
    db.run('UPDATE investments SET invested_amount=? WHERE id=?',[Math.round(cost*100)/100,iv[0]])
   }
   db.run("INSERT OR REPLACE INTO app_settings VALUES('legacy_cost_migrated','1')")
  }
 } catch {}
 persist()
}
function b64(bytes:Uint8Array){ let s=''; for(let i=0;i<bytes.length;i+=8192) s+=String.fromCharCode(...bytes.subarray(i,i+8192)); return btoa(s) }
let persistTimer: ReturnType<typeof setTimeout> | null = null
function persistNow(){ if(DB) localStorage.setItem(KEY,b64(DB.export())) }
function persist(){ if(persistTimer||!DB) return; persistTimer=setTimeout(()=>{ persistTimer=null; persistNow() },250) }
export function flushPersist(){ if(persistTimer){ clearTimeout(persistTimer); persistTimer=null } persistNow() }
if(typeof window!=='undefined'){
  window.addEventListener('pagehide',flushPersist)
  document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='hidden') flushPersist() })
}
export async function listProducts():Promise<Product[]>{
 let db:any=await init(); const r=db.exec('SELECT * FROM products ORDER BY updated_at DESC')
 return r[0]?.values.map((v:any)=>({id:String(v[0]),name:String(v[1]),cost:Number(v[2]),freight:Number(v[3]),packaging:Number(v[4]),otherCosts:Number(v[5]),category:String(v[6]||'Geral'),salePrice:Number(v[7]||0),desiredMarginPct:Number(v[8]||20),marketplace:String(v[9]||'Venda direta'),createdAt:String(v[10]),updatedAt:String(v[11])}))||[]
}
export async function upsertProduct(p:Product){ const db:any=await init(); p.updatedAt=todayISO(); if(!p.createdAt)p.createdAt=p.updatedAt
 db.run('INSERT OR REPLACE INTO products VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[p.id,p.name,p.cost,p.freight,p.packaging,p.otherCosts,p.category,p.salePrice,p.desiredMarginPct,p.marketplace,p.createdAt,p.updatedAt]); persist(); return p}
export async function deleteProduct(id:string){ const db:any=await init(); db.run('DELETE FROM products WHERE id=?',[id]); persist()}
export async function duplicateProduct(id:string){ const all=await listProducts(); const p=all.find(x=>x.id===id); if(!p)return null; const c={...p,id:newId(),name:p.name+' (cópia)',createdAt:todayISO()}; return upsertProduct(c)}
export async function listMarketplaces():Promise<Marketplace[]>{ let db:any=await init(); const r=db.exec('SELECT * FROM marketplaces ORDER BY name'); return r[0]?.values.map((v:any)=>({id:String(v[0]),name:String(v[1]),commissionPct:Number(v[2]),paymentPct:Number(v[3]),fixedFee:Number(v[4]),taxPct:Number(v[5]),isDefault:Boolean(v[6]),note:String(v[7]),createdAt:String(v[8])}))||[]}
export async function upsertMarketplace(m:Marketplace){ const db:any=await init(); db.run('INSERT OR REPLACE INTO marketplaces VALUES(?,?,?,?,?,?,?,?,?)',[m.id,m.name,m.commissionPct,m.paymentPct,m.fixedFee,m.taxPct,m.isDefault?1:0,m.note,m.createdAt||todayISO()]); persist(); return m}
export async function deleteMarketplace(id:string){ const db:any=await init(); db.run('DELETE FROM marketplaces WHERE id=?',[id]); persist()}
export async function logSimulation(productId:string,payload:any){ const db:any=await init(); db.run('INSERT INTO pricing_simulations VALUES(?,?,?,?)',[newId(),productId,JSON.stringify(payload),todayISO()]); persist()}
export async function getSetting(k:string){ let db:any=await init(); const r=db.exec(`SELECT value FROM app_settings WHERE key='${k.replace(/'/g,"''")}'`); return r[0]?.values[0]?.[0]?String(r[0].values[0][0]):''}
export async function setSetting(k:string,v:string){ const db:any=await init(); db.run('INSERT OR REPLACE INTO app_settings VALUES(?,?)',[k,v]); persist()}
export async function exportBackup(){ await init(); return DB!.export() }
export async function importBackup(bytes:Uint8Array){ flushPersist(); localStorage.setItem(KEY,b64(bytes)); DB=null; await init() }
export async function listTransactions(userId:string):Promise<Transaction[]>{ const db:any=await init(); const r=db.exec('SELECT * FROM transactions WHERE user_id=? ORDER BY date DESC, created_at DESC',[userId]); return r[0]?.values.map((v:any)=>({id:String(v[0]),description:String(v[1]),amount:Number(v[2]),type:v[3]==='in'?'in':'out',category:String(v[4]||'Outros'),date:String(v[5]),note:String(v[6]||''),createdAt:String(v[7])}))||[] }
export async function addTransaction(t:Transaction){ const db:any=await init(); t.createdAt=t.createdAt||todayISO(); db.run('INSERT OR REPLACE INTO transactions VALUES(?,?,?,?,?,?,?,?,?)',[t.id,t.description,Math.round(t.amount*100)/100,t.type,t.category,t.date,t.note||'',t.createdAt,t.userId]); persist(); return t }
export async function deleteTransaction(id:string,userId:string){ const db:any=await init(); db.run('DELETE FROM transactions WHERE id=? AND user_id=?',[id,userId]); persist() }
export async function listFixedBills(userId:string):Promise<FixedBill[]>{ const db:any=await init(); const r=db.exec('SELECT * FROM fixed_bills WHERE user_id=? ORDER BY due_day ASC',[userId]); return r[0]?.values.map((v:any)=>({id:String(v[0]),name:String(v[1]),amount:Number(v[2]),dueDay:Number(v[3]||1),category:String(v[4]||'Contas da casa'),createdAt:String(v[5])}))||[] }
export async function upsertFixedBill(b:FixedBill){ const db:any=await init(); b.createdAt=b.createdAt||todayISO(); db.run('INSERT OR REPLACE INTO fixed_bills VALUES(?,?,?,?,?,?,?)',[b.id,b.name,Math.round(b.amount*100)/100,Math.max(1,Math.min(28,Math.round(b.dueDay))),b.category,b.createdAt,b.userId]); persist(); return b }
export async function deleteFixedBill(id:string,userId:string){ const db:any=await init(); db.run('DELETE FROM fixed_bills WHERE id=? AND user_id=?',[id,userId]); persist() }
export async function listGoals(userId:string):Promise<Goal[]>{ const db:any=await init(); const r=db.exec('SELECT id,name,target,saved,deadline,created_at,auto_monthly FROM goals WHERE user_id=? ORDER BY created_at DESC',[userId]); return r[0]?.values.map((v:any)=>({id:String(v[0]),name:String(v[1]),target:Number(v[2]),saved:Number(v[3]),deadline:String(v[4]||''),createdAt:String(v[5]),autoMonthly:Number(v[6]||0)}))||[] }
export async function upsertGoal(g:Goal){ const db:any=await init(); g.createdAt=g.createdAt||todayISO(); db.run('INSERT OR REPLACE INTO goals(id,name,target,saved,deadline,created_at,auto_monthly,user_id) VALUES(?,?,?,?,?,?,?,?)',[g.id,g.name,Math.round(g.target*100)/100,Math.round(g.saved*100)/100,g.deadline||'',g.createdAt,Math.round((g.autoMonthly||0)*100)/100,g.userId]); persist(); return g }
export async function listGoalAutoLaunches(userId:string):Promise<{goalId:string;month:string}[]>{ const db:any=await init(); const r=db.exec('SELECT goal_id, month FROM goal_auto_launches WHERE user_id=?',[userId]); return r[0]?.values.map((v:any)=>({goalId:String(v[0]),month:String(v[1])}))||[] }
export async function markGoalAutoLaunched(goalId:string,month:string,userId:string){ const db:any=await init(); db.run('INSERT OR IGNORE INTO goal_auto_launches VALUES(?,?,?)',[goalId,month,userId]); persist() }
export async function deleteGoal(id:string,userId:string){ const db:any=await init(); db.run('DELETE FROM goals WHERE id=? AND user_id=?',[id,userId]); persist() }
export async function listBudgets(userId:string):Promise<Budget[]>{ const db:any=await init(); const r=db.exec('SELECT * FROM budgets WHERE user_id=? ORDER BY category',[userId]); return r[0]?.values.map((v:any)=>({category:String(v[0]),limit:Number(v[1])}))||[] }
export async function setBudget(category:string,limit:number,userId:string){ const db:any=await init(); if(limit<=0){ db.run('DELETE FROM budgets WHERE category=? AND user_id=?',[category,userId]) } else { db.run('INSERT OR REPLACE INTO budgets VALUES(?,?,?)',[category,Math.round(limit*100)/100,userId]) } persist() }
export async function listCreditCards(userId:string):Promise<CreditCard[]>{ const db:any=await init(); const r=db.exec('SELECT * FROM credit_cards WHERE user_id=? ORDER BY name',[userId]); return r[0]?.values.map((v:any)=>({id:String(v[0]),userId:String(v[1]),name:String(v[2]),brand:String(v[3]||''),limitAmount:Number(v[4]||0),closingDay:Number(v[5]||1),dueDay:Number(v[6]||10),color:String(v[7]||'#0E9F6E'),createdAt:String(v[8]),updatedAt:String(v[9]||v[8])}))||[] }
export async function upsertCreditCard(c:CreditCard){ const db:any=await init(); const now=todayISO(); c.createdAt=c.createdAt||now; c.updatedAt=now; db.run('INSERT OR REPLACE INTO credit_cards VALUES(?,?,?,?,?,?,?,?,?,?)',[c.id,c.userId,c.name,c.brand,Math.round(c.limitAmount*100)/100,Math.max(1,Math.min(28,Math.round(c.closingDay))),Math.max(1,Math.min(28,Math.round(c.dueDay))),c.color,c.createdAt,c.updatedAt]); persist(); return c }
export async function deleteCreditCard(id:string,userId:string){ const db:any=await init(); db.run('DELETE FROM credit_card_purchases WHERE card_id=? AND user_id=?',[id,userId]); db.run('DELETE FROM credit_card_payments WHERE card_id=? AND user_id=?',[id,userId]); db.run('DELETE FROM credit_cards WHERE id=? AND user_id=?',[id,userId]); persist() }
export async function listCreditCardPurchases(userId:string):Promise<CreditCardPurchase[]>{ const db:any=await init(); const r=db.exec('SELECT * FROM credit_card_purchases WHERE user_id=? ORDER BY first_date DESC, created_at DESC',[userId]); return r[0]?.values.map((v:any)=>({id:String(v[0]),userId:String(v[1]),cardId:String(v[2]),description:String(v[3]),category:String(v[4]||'Outros'),totalAmount:Number(v[5]||0),installments:Math.max(1,Number(v[6]||1)),firstDate:String(v[7]),notes:String(v[8]||''),createdAt:String(v[9]),updatedAt:String(v[10]||v[9])}))||[] }
export async function upsertCreditCardPurchase(p:CreditCardPurchase){ const db:any=await init(); const now=todayISO(); p.createdAt=p.createdAt||now; p.updatedAt=now; db.run('INSERT OR REPLACE INTO credit_card_purchases VALUES(?,?,?,?,?,?,?,?,?,?,?)',[p.id,p.userId,p.cardId,p.description,Math.round(p.totalAmount*100)/100,Math.max(1,Math.min(60,Math.round(p.installments))),p.firstDate,p.category,p.notes||'',p.createdAt,p.updatedAt]); persist(); return p }
export async function deleteCreditCardPurchase(id:string,userId:string){ const db:any=await init(); db.run('DELETE FROM credit_card_purchases WHERE id=? AND user_id=?',[id,userId]); persist() }
export async function listCreditCardPayments(userId:string):Promise<CreditCardPayment[]>{ const db:any=await init(); const r=db.exec('SELECT card_id,month,paid_at FROM credit_card_payments WHERE user_id=?',[userId]); return r[0]?.values.map((v:any)=>({cardId:String(v[0]),month:String(v[1]),paidAt:String(v[2])}))||[] }
export async function setCreditCardPaid(cardId:string,month:string,paid:boolean,userId:string){ const db:any=await init(); if(paid){ db.run('INSERT OR REPLACE INTO credit_card_payments VALUES(?,?,?,?)',[cardId,month,todayISO(),userId]) } else { db.run('DELETE FROM credit_card_payments WHERE card_id=? AND month=? AND user_id=?',[cardId,month,userId]) } persist() }
export async function listBillPayments(userId:string):Promise<BillPayment[]>{ const db:any=await init(); const r=db.exec('SELECT * FROM bill_payments WHERE user_id=?',[userId]); return r[0]?.values.map((v:any)=>({billId:String(v[0]),month:String(v[1]),paidAt:String(v[2])}))||[] }
export async function setBillPaid(billId:string,month:string,paid:boolean,userId:string){ const db:any=await init(); if(paid){ db.run('INSERT OR REPLACE INTO bill_payments VALUES(?,?,?,?)',[billId,month,todayISO(),userId]) } else { db.run('DELETE FROM bill_payments WHERE bill_id=? AND month=? AND user_id=?',[billId,month,userId]) } persist() }
export async function listRecurrences(userId:string):Promise<Recurrence[]>{ const db:any=await init(); const r=db.exec('SELECT * FROM recurrences WHERE user_id=? ORDER BY day ASC',[userId]); return r[0]?.values.map((v:any)=>({id:String(v[0]),description:String(v[1]),amount:Number(v[2]),type:v[3]==='in'?'in':'out',category:String(v[4]||'Outros'),day:Number(v[5]||1),active:Boolean(v[6]),createdAt:String(v[7])}))||[] }
export async function upsertRecurrence(r:Recurrence){ const db:any=await init(); r.createdAt=r.createdAt||todayISO(); db.run('INSERT OR REPLACE INTO recurrences VALUES(?,?,?,?,?,?,?,?,?)',[r.id,r.description,Math.round(r.amount*100)/100,r.type,r.category,Math.max(1,Math.min(28,Math.round(r.day))),r.active?1:0,r.createdAt,r.userId]); persist(); return r }
export async function deleteRecurrence(id:string,userId:string){ const db:any=await init(); db.run('DELETE FROM recurrences WHERE id=? AND user_id=?',[id,userId]); persist() }
export async function listRecurrenceLaunches(userId:string):Promise<{recurrenceId:string;month:string}[]>{ const db:any=await init(); const r=db.exec('SELECT recurrence_id, month FROM recurrence_launches WHERE user_id=?',[userId]); return r[0]?.values.map((v:any)=>({recurrenceId:String(v[0]),month:String(v[1])}))||[] }
export async function markRecurrenceLaunched(recurrenceId:string,month:string,userId:string){ const db:any=await init(); db.run('INSERT OR IGNORE INTO recurrence_launches VALUES(?,?,?)',[recurrenceId,month,userId]); persist() }
export async function wasRecurrenceLaunched(recurrenceId:string,month:string,userId:string){ const all=await listRecurrenceLaunches(userId); return all.some(l=>l.recurrenceId===recurrenceId&&l.month===month) }
export async function listCategories(userId:string):Promise<Category[]>{ const db:any=await init(); const r=db.exec("SELECT DISTINCT name,type FROM categories WHERE user_id=? OR user_id IS NULL OR user_id='' ORDER BY type, name",[userId]); return r[0]?.values.map((v:any)=>({name:String(v[0]),type:v[1]==='in'?'in':'out'}))||[] }
export async function addCategory(name:string,type:'in'|'out',userId:string){ const db:any=await init(); db.run('INSERT OR IGNORE INTO categories VALUES(?,?,?)',[name.trim(),type,userId]); persist() }
export async function deleteCategory(name:string,type:'in'|'out',userId:string){ const db:any=await init(); db.run("DELETE FROM categories WHERE name=? AND type=? AND (user_id=? OR user_id IS NULL OR user_id='')",[name,type,userId]); persist() }
export async function clearAllData(userId:string){ const db:any=await init(); for (const tbl of ['transactions','fixed_bills','goals','budgets','bill_payments','recurrences','recurrence_launches','categories','goal_auto_launches','investment_transactions','investments']) { try { db.run(`DELETE FROM ${tbl} WHERE user_id=?`,[userId]) } catch {} } persist() }
export async function listInvestments(userId:string):Promise<Investment[]>{ const db:any=await init(); const r=db.exec('SELECT * FROM investments WHERE user_id=? ORDER BY name ASC',[userId]); return r[0]?.values.map((v:any)=>({id:String(v[0]),userId:String(v[1]),name:String(v[2]),category:String(v[3]||'Outros'),ticker:String(v[4]||''),institution:String(v[5]||''),quantity:Number(v[6]||0),averagePrice:Number(v[7]||0),investedAmount:Number(v[8]||0),currentValue:Number(v[9]||0),startedAt:String(v[10]||''),notes:String(v[11]||''),createdAt:String(v[12]),updatedAt:String(v[13])}))||[] }
export async function upsertInvestment(inv:Investment){ const db:any=await init(); const ex=db.exec('SELECT user_id FROM investments WHERE id=?',[inv.id])[0]?.values[0]?.[0]; if(ex!=null&&String(ex)!==inv.userId) throw new Error('Investimento pertence a outro usuário'); inv.updatedAt=todayISO(); if(!inv.createdAt) inv.createdAt=inv.updatedAt; db.run('INSERT OR REPLACE INTO investments VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[inv.id,inv.userId,inv.name,inv.category,inv.ticker,inv.institution,Math.round(inv.quantity*1e8)/1e8,Math.round(inv.averagePrice*100)/100,Math.round(inv.investedAmount*100)/100,Math.round(inv.currentValue*100)/100,inv.startedAt,inv.notes,inv.createdAt,inv.updatedAt]); persist(); return inv }
export async function deleteInvestment(id:string,userId:string){ const db:any=await init(); db.run('DELETE FROM investment_transactions WHERE investment_id=? AND user_id=?',[id,userId]); db.run('DELETE FROM investments WHERE id=? AND user_id=?',[id,userId]); persist() }
const mapItx=(v:any):InvestmentTransaction=>({id:String(v[0]),investmentId:String(v[1]),userId:String(v[2]),type:v[3],quantity:Number(v[4]||0),unitPrice:Number(v[5]||0),amount:Number(v[6]||0),date:String(v[7]),description:String(v[8]||''),createdAt:String(v[9]),costRemoved:Number(v[10]||0),realizedGain:Number(v[11]||0)})
export async function listInvestmentTransactions(investmentId:string,userId:string):Promise<InvestmentTransaction[]>{ const db:any=await init(); const r=db.exec('SELECT id,investment_id,user_id,type,quantity,unit_price,amount,date,description,created_at,cost_removed,realized_gain FROM investment_transactions WHERE investment_id=? AND user_id=? ORDER BY date DESC, created_at DESC',[investmentId,userId]); return r[0]?.values.map(mapItx)||[] }
export async function listAllInvestmentTransactions(userId:string):Promise<InvestmentTransaction[]>{ const db:any=await init(); const r=db.exec('SELECT id,investment_id,user_id,type,quantity,unit_price,amount,date,description,created_at,cost_removed,realized_gain FROM investment_transactions WHERE user_id=? ORDER BY date ASC',[userId]); return r[0]?.values.map(mapItx)||[] }
export async function getInvestmentTransaction(txId:string,userId:string):Promise<InvestmentTransaction|null>{ const db:any=await init(); const r=db.exec('SELECT id,investment_id,user_id,type,quantity,unit_price,amount,date,description,created_at,cost_removed,realized_gain FROM investment_transactions WHERE id=? AND user_id=?',[txId,userId]); return r[0]?.values.length?mapItx(r[0].values[0]):null }
export async function addInvestmentTransaction(tx:InvestmentTransaction, updated:Investment){ const db:any=await init(); const own=db.exec('SELECT id FROM investments WHERE id=? AND user_id=?',[tx.investmentId,tx.userId])[0]?.values[0]?.[0]; if(!own) throw new Error('Investimento não encontrado para este usuário'); tx.createdAt=tx.createdAt||todayISO(); db.run('INSERT OR REPLACE INTO investment_transactions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[tx.id,tx.investmentId,tx.userId,tx.type,Math.round(tx.quantity*1e8)/1e8,Math.round(tx.unitPrice*100)/100,Math.round(tx.amount*100)/100,tx.date,tx.description||'',tx.createdAt,Math.round((tx.costRemoved||0)*100)/100,Math.round((tx.realizedGain||0)*100)/100]); db.run('UPDATE investments SET quantity=?, average_price=?, invested_amount=?, current_value=?, updated_at=? WHERE id=? AND user_id=?',[Math.round(updated.quantity*1e8)/1e8,Math.round(updated.averagePrice*100)/100,Math.round(updated.investedAmount*100)/100,Math.round(updated.currentValue*100)/100,todayISO(),updated.id,updated.userId]); persist(); return tx }
export async function deleteInvestmentTransaction(txId:string,userId:string,updated:Investment){ const db:any=await init(); const own=db.exec('SELECT id FROM investment_transactions WHERE id=? AND user_id=?',[txId,userId])[0]?.values[0]?.[0]; if(!own) throw new Error('Movimentação não encontrada para este usuário'); db.run('DELETE FROM investment_transactions WHERE id=? AND user_id=?',[txId,userId]); db.run('UPDATE investments SET quantity=?, average_price=?, invested_amount=?, current_value=?, updated_at=? WHERE id=? AND user_id=?',[Math.round(updated.quantity*1e8)/1e8,Math.round(updated.averagePrice*100)/100,Math.round(updated.investedAmount*100)/100,Math.round(updated.currentValue*100)/100,todayISO(),updated.id,updated.userId]); persist(); return updated }
export async function replaceInvestmentTransaction(oldTxId:string, tx:InvestmentTransaction, updated:Investment){ const db:any=await init(); const own=db.exec('SELECT id FROM investment_transactions WHERE id=? AND user_id=?',[oldTxId,tx.userId])[0]?.values[0]?.[0]; if(!own) throw new Error('Movimentação não encontrada para este usuário'); db.run('UPDATE investment_transactions SET investment_id=?,type=?,quantity=?,unit_price=?,amount=?,date=?,description=?,cost_removed=?,realized_gain=? WHERE id=? AND user_id=?',[tx.investmentId,tx.type,Math.round(tx.quantity*1e8)/1e8,Math.round(tx.unitPrice*100)/100,Math.round(tx.amount*100)/100,tx.date,tx.description||'',Math.round((tx.costRemoved||0)*100)/100,Math.round((tx.realizedGain||0)*100)/100,oldTxId,tx.userId]); db.run('UPDATE investments SET quantity=?, average_price=?, invested_amount=?, current_value=?, updated_at=? WHERE id=? AND user_id=?',[Math.round(updated.quantity*1e8)/1e8,Math.round(updated.averagePrice*100)/100,Math.round(updated.investedAmount*100)/100,Math.round(updated.currentValue*100)/100,todayISO(),updated.id,updated.userId]); persist(); return updated }
const SYNC_TABLES = ['transactions','fixed_bills','goals','budgets','bill_payments','recurrences','recurrence_launches','categories','goal_auto_launches','investments','investment_transactions']
/** Atribui registros sem dono ao usuário legado do aparelho (chamado após garantir userId). */
export async function backfillLegacyUser(userId:string){
  const db:any=await init()
  for (const tbl of SYNC_TABLES) { try { db.run(`UPDATE ${tbl} SET user_id=? WHERE user_id IS NULL OR user_id=''`,[userId]) } catch {} }
  persist()
}
// ---- Sync (fila de tombstones, metas e conflitos são por usuário) ----
export async function enqueueSyncOp(op:any){ const db:any=await init(); db.run('INSERT OR IGNORE INTO sync_queue VALUES(?,?,?,?,?,?,?,?,?,?)',[op.opId,op.entity,op.userId,op.recordId,op.op,JSON.stringify(op.payload),op.baseVersion||0,op.attempts||0,op.nextRetryAt||'',op.createdAt]); persist() }
export async function listSyncQueue(userId:string){ const db:any=await init(); const r=db.exec('SELECT op_id,entity,record_id,op,payload,base_version,attempts,next_retry_at,created_at FROM sync_queue WHERE user_id=? ORDER BY created_at ASC',[userId]); return (r[0]?.values||[]).map((v:any)=>({opId:String(v[0]),entity:v[1],recordId:String(v[2]),op:v[3],payload:JSON.parse(String(v[4])),baseVersion:Number(v[5]||0),attempts:Number(v[6]||0),nextRetryAt:String(v[7]||''),createdAt:String(v[8])})) }
export async function saveSyncQueue(ops:any[]){ const db:any=await init(); db.run('DELETE FROM sync_queue'); for (const op of ops) db.run('INSERT OR REPLACE INTO sync_queue VALUES(?,?,?,?,?,?,?,?,?,?)',[op.opId,op.entity,op.userId,op.recordId,op.op,JSON.stringify(op.payload),op.baseVersion||0,op.attempts||0,op.nextRetryAt||'',op.createdAt]); persist() }
export async function getSyncMeta(entity:string,userId:string){ const db:any=await init(); const r=db.exec('SELECT record_id,hash,version FROM sync_meta WHERE entity=? AND user_id=?',[entity,userId]); const m=new Map(); for (const v of (r[0]?.values||[])) m.set(String(v[0]),{hash:String(v[1]),version:Number(v[2]||0)}); return m }
export async function setSyncMeta(entity:string,userId:string,meta:Map<string,any>){ const db:any=await init(); db.run('DELETE FROM sync_meta WHERE entity=? AND user_id=?',[entity,userId]); for (const [rid,mm] of meta) db.run('INSERT INTO sync_meta VALUES(?,?,?,?,?)',[entity,userId,rid,mm.hash,mm.version]); persist() }
export async function getSyncState(entity:string){ const db:any=await init(); const r=db.exec('SELECT last_pulled_at,last_sync_at FROM sync_state WHERE entity=?',[entity]); return r[0]?.values[0] ? { lastPulledAt: String(r[0].values[0][0]||''), lastSyncAt: String(r[0].values[0][1]||'') } : { lastPulledAt: '', lastSyncAt: '' } }
export async function setSyncState(entity:string,lastPulledAt:string,lastSyncAt:string){ const db:any=await init(); db.run('INSERT OR REPLACE INTO sync_state VALUES(?,?,?)',[entity,lastPulledAt,lastSyncAt]); persist() }
export async function addSyncConflicts(conflicts:any[],userId:string){ const db:any=await init(); for (const c of conflicts) { db.run("DELETE FROM sync_conflicts WHERE user_id=? AND entity=? AND record_id=? AND resolved_at IS NULL",[userId,c.entity,c.recordId]); db.run('INSERT OR REPLACE INTO sync_conflicts VALUES(?,?,?,?,?,?,?,?,?,?,?)',[c.id,c.entity,userId,c.recordId,JSON.stringify(c.local),JSON.stringify(c.remote),c.localVersion,c.remoteVersion,c.createdAt,c.resolvedAt||'']); } persist() }
export async function listSyncConflicts(userId:string){ const db:any=await init(); const r=db.exec('SELECT id,entity,record_id,local,remote,local_version,remote_version,created_at,resolved_at FROM sync_conflicts WHERE user_id=? AND resolved_at IS NULL ORDER BY created_at ASC',[userId]); return (r[0]?.values||[]).map((v:any)=>({id:String(v[0]),entity:v[1],recordId:String(v[2]),local:JSON.parse(String(v[3])),remote:JSON.parse(String(v[4])),localVersion:Number(v[5]||0),remoteVersion:Number(v[6]||0),createdAt:String(v[7]),resolvedAt:String(v[8]||'')})) }
export async function resolveSyncConflict(id:string){ const db:any=await init(); db.run("UPDATE sync_conflicts SET resolved_at=? WHERE id=?",[todayISO(),id]); persist() }
/** Migração de dados legados: conta registros por dono e reatribui o dono legado à conta autenticada. */
export async function legacyCounts(_excludeUid:string){
  const db:any=await init(); const out:Record<string,number>={}
  for (const tbl of SYNC_TABLES) { const r=db.exec(`SELECT user_id, COUNT(*) FROM ${tbl} GROUP BY user_id`)[0]?.values||[]; for (const v of r) out[`${tbl}:${v[0]}`]=Number(v[1]) }
  return out
}
export async function reassignLegacyUser(oldUid:string,newUid:string){
  const counts=await legacyCounts(newUid)
  const ambiguous=Object.entries(counts).filter(([k,_v])=>{ const uid=k.split(':').pop(); return uid!==oldUid&&uid!==newUid&&uid!==''&&uid!=='null' }).reduce((a,[,v])=>a+v,0)
  if (ambiguous>0) throw new Error(`Registros com identidade ambígua (${ambiguous}) — importação interrompida.`)
  const db:any=await init(); let moved=0
  for (const tbl of SYNC_TABLES) { const before=db.exec(`SELECT COUNT(*) v FROM ${tbl} WHERE user_id=?`,[oldUid])[0]?.values[0]?.[0]||0; db.run(`UPDATE ${tbl} SET user_id=? WHERE user_id=?`,[newUid,oldUid]); moved+=Number(before) }
  persist(); return moved
}
export function dbReady(){ return init() }
