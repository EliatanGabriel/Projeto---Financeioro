import type {PricingInputs,PricingResult,Scenario} from '../types'
import {z} from 'zod'
const toCents=(v:number)=>Math.round((Number(v)||0)*100)
const fromCents=(c:number)=>Math.round(c)/100
export const PricingSchema=z.object({
 name:z.string().max(120).default(''), cost:z.number().min(0).max(1e9), freight:z.number().min(0).max(1e9),
 packaging:z.number().min(0).max(1e9), otherCosts:z.number().min(0).max(1e9),
 taxPct:z.number().min(0).max(100), marketplacePct:z.number().min(0).max(100),
 paymentPct:z.number().min(0).max(100), fixedFee:z.number().min(0).max(1e7),
 desiredMarginPct:z.number().min(0).max(95), salePrice:z.number().min(0).max(1e9)
})
export function validatePricing(i:PricingInputs):string[]{
 const p=PricingSchema.safeParse(i); const errs:string[]=[]
 if(!p.success) errs.push(...p.error.issues.map(x=>`${x.path.join('.')}: ${x.message}`))
 const pctSum=i.taxPct+i.marketplacePct+i.paymentPct+i.desiredMarginPct
 if(pctSum>=100) errs.push('Soma de percentuais + margem >= 100% — denominador inválido.')
 if(i.cost<0||i.freight<0||i.packaging<0||i.otherCosts<0||i.fixedFee<0||i.salePrice<0) errs.push('Valores monetários não podem ser negativos.')
 if(i.taxPct<0||i.marketplacePct<0||i.paymentPct<0||i.desiredMarginPct<0) errs.push('Percentuais não podem ser negativos.')
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
