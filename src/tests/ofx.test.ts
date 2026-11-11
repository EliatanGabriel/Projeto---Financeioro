import { describe, expect, it } from 'vitest'
import { looksLikeOfx, parseOfx } from '../utils/ofx'

const SGML = `
OFXHEADER:100
DATA:OFXSGML
<OFX>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260105120000[-3:BRT]
<TRNAMT>-45.90
<FITID>abc1
<NAME>Supermercado Pão de Açúcar
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260107120000
<TRNAMT>2500.00
<FITID>abc2
<NAME>Salário
<MEMO>Pagamento mensal
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260110120000
<TRNAMT>0
<NAME>Ignorar zero
</STMTTRN>
</BANKTRANLIST>
</OFX>`

describe('importação OFX', () => {
  it('reconhece OFX e converte lançamentos', () => {
    expect(looksLikeOfx(SGML)).toBe(true)
    expect(looksLikeOfx('Data;Descrição;Tipo;Categoria;Valor')).toBe(false)
    const txs = parseOfx(SGML)
    expect(txs).toHaveLength(2)
    expect(txs[0]).toMatchObject({ description: 'Supermercado Pão de Açúcar', amount: 45.9, type: 'out', category: 'Alimentação', date: '2026-01-05' })
    expect(txs[1]).toMatchObject({ description: 'Salário', amount: 2500, type: 'in', date: '2026-01-07' })
    expect(txs[0].id).not.toBe(txs[1].id)
  })
  it('aceita XML com tags fechadas e não quebra com lixo', () => {
    const xml = `<OFX><STMTTRN><DTPOSTED>20260215</DTPOSTED><TRNAMT>-12,50</TRNAMT><MEMO>Uber</MEMO></STMTTRN></OFX>`
    const txs = parseOfx(xml)
    expect(txs[0]).toMatchObject({ amount: 12.5, type: 'out', category: 'Transporte', date: '2026-02-15' })
    expect(parseOfx('sem nada')).toEqual([])
    expect(parseOfx('<STMTTRN><DTPOSTED>invalida</DTPOSTED><TRNAMT>-1</TRNAMT></STMTTRN>')).toEqual([])
  })
})
