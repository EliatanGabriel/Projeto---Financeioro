import type {PricingInputs,PricingResult,Scenario} from '../types'
const toCents=(v:number)=>Math.round((Number(v)||0)*100)
const fromCents=(c:number)=>Math.round(c)/100
export function validatePricing(i:PricingInputs):string[]{
 const errs:string[]=[]
 if(typeof i.cost!=='number'||i.cost<0) errs.push('Custo inválido.')
 if(typeof i.freight!=='number'||i.freight<0) errs.push('Frete inválido.')
 if(typeof i.packaging!=='number'||i.packaging<0) errs.push('Embalagem inválida.')
 if(typeof i.otherCosts!=='number'||i.otherCosts<0) errs.push('Outros custos inválidos.')
 if(typeof i.taxPct!=='number'||i.taxPct<0||i.taxPct>100) errs.push('Imposto inválido.')
 if(typeof i.marketplacePct!=='number'||i.marketplacePct<0||i.marketplacePct>100) errs.push('Percentual de marketplace inválido.')
 if(typeof i.paymentPct!=='number'||i.paymentPct<0||i.paymentPct>100) errs.push('Percentual de pagamento inválido.')
 if(typeof i.desiredMarginPct!=='number'||i.desiredMarginPct<0||i.desiredMarginPct>95) errs.push('Margem desejada inválida.')
 if(typeof i.salePrice!=='number'||i.salePrice<0) errs.push('Preço de venda inválido.')
 const pctSum=i.taxPct+i.marketplacePct+i.paymentPct+i.desiredMarginPct
 if(pctSum>=100) errs.push('Soma de percentuais + margem >= 100% — denominador inválido.')
 return errs
}
export function calculatePricing(i:PricingInputs):PricingResult{
 const errors=validatePricing(i)
 const fixed=toCents(i.cost)+toCents(i.freight)+toCents(i.packaging)+toCents(i.otherCosts)+toCents(i.fixedFee)
 const pct=(i.taxPct+i.marketplacePct+i.paymentPct)/100
 const margin=i.desiredMarginPct/100
 const denom=1-pct-margin
 const suggested = denom>0 ? Math.ceil((fixed/(denom*100))*100)/100 : 0
 const denomMin=1-pct
 const minPrice = denomMin>0 ? Math.ceil((fixed/(denomMin*100))*100)/100 : 0
 const price=toCents(i.salePrice)
 const tax=price*i.taxPct/100, mkt=price*i.marketplacePct/100, pay=price*i.paymentPct/100
 const totalFees=Math.round(tax+mkt+pay)+toCents(i.fixedFee)
 const costTotal=toCents(i.cost)+toCents(i.freight)+toCents(i.packaging)+toCents(i.otherCosts)
 const net=price - costTotal - totalFees
 const realMargin = price>0 ? (net/price)*100 : 0
 const roi = costTotal>0 ? (net/costTotal)*100 : 0
 const markup = costTotal>0 ? (net/costTotal)*100 : 0
 return {fixedCostsTotal:fromCents(fixed), totalFees:fromCents(totalFees), costTotal:fromCents(costTotal),
  suggestedPrice:suggested, minPrice, netProfit:fromCents(net),
  realMarginPct:Math.round(realMargin*100)/100, roiPct:Math.round(roi*100)/100, markupPct:Math.round(markup*100)/100,
  valid:errors.length===0&&denom>0, errors, taxValue:fromCents(Math.round(tax)), marketplaceValue:fromCents(Math.round(mkt)), paymentValue:fromCents(Math.round(pay))}
}
export function compareScenarios(inputs:PricingInputs,scenarios:Scenario[]){
 return scenarios.map(s=>{const r=calculatePricing({...inputs,salePrice:s.price,desiredMarginPct:0});return {...s,...r}})
}
export function marginStatus(m:number){return m<0?{label:'Prejuízo',color:'#DC2626'}:m<10?{label:'Baixa',color:'#D97706'}:m<20?{label:'Moderada',color:'#2563EB'}:{label:'Saudável',color:'#059669'}}
