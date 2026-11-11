import type { Transaction } from '../types'
import { newId, num } from './format'

function tagValue(body: string, tag: string): string {
  const m = body.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i'))
  return m ? m[1].trim() : ''
}

function ofxDate(raw: string): string | null {
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})/)
  if (!m) return null
  const date = `${m[1]}-${m[2]}-${m[3]}`
  const d = new Date(date + 'T12:00:00')
  return isNaN(d.getTime()) ? null : date
}

const CATEGORY_HINTS: Array<[RegExp, string]> = [
  [/supermerc|mercado|hiper|atacad|padaria|açougue|hortifr/i, 'Alimentação'],
  [/restauran|lanchon|pizza|ifood|delivery|caf[eé]|bar\b/i, 'Alimentação'],
  [/farm[aá]cia|drogaria|hospital|cl[ií]nica|laborat/i, 'Saúde'],
  [/uber|99|taxi|combust|posto|estacion|ped[aá]gio|metro|ônibus|onibus/i, 'Transporte'],
  [/aluguel|condom[ií]nio|luz|energia|internet|telefone|celular|[aá]gua|g[aá]s\b/i, 'Contas da casa'],
  [/netflix|spotify|prime|stream|disney|hbo|assinatura/i, 'Assinaturas'],
  [/escola|curso|faculdade|livraria|educa/i, 'Educação'],
  [/loja|magazine|americanas|shopee|mercado ?livre|amazon|vestu[aá]rio|roupa/i, 'Compras'],
  [/sal[aá]rio|pagamento|provento|rendimento|transfer[eê]ncia recebida|pix recebido/i, 'Salário'],
]

function guessCategory(description: string): string {
  for (const [re, category] of CATEGORY_HINTS) if (re.test(description)) return category
  return 'Outros'
}

export function looksLikeOfx(text: string): boolean {
  return /<OFX[\s>]/i.test(text) || /<STMTTRN>/i.test(text)
}

export function parseOfx(text: string): Transaction[] {
  const out: Transaction[] = []
  const blocks = text.match(/<STMTTRN>[\s\S]*?(?:<\/STMTTRN>|(?=<STMTTRN>)|$)/gi) || []
  for (const block of blocks) {
    const rawAmount = tagValue(block, 'TRNAMT')
    const amount = num(rawAmount)
    if (!amount) continue
    const date = ofxDate(tagValue(block, 'DTPOSTED'))
    if (!date) continue
    const name = tagValue(block, 'NAME') || tagValue(block, 'PAYEE') || tagValue(block, 'MEMO')
    const description = (name || 'Importado').slice(0, 120)
    const type: 'in' | 'out' = amount < 0 ? 'out' : 'in'
    out.push({
      id: newId(),
      description,
      amount: Math.abs(amount),
      type,
      category: guessCategory(description),
      date,
      createdAt: new Date().toISOString(),
    })
  }
  return out
}
