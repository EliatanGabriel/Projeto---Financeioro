import {describe,it,expect} from 'vitest'
import {calculatePricing,validatePricing} from '../calculations/pricing'
const base={name:'P',cost:20,freight:0,packaging:0,otherCosts:0,taxPct:0,marketplacePct:0,paymentPct:0,fixedFee:0,desiredMarginPct:0,salePrice:40}
describe('motor de cálculo',()=>{
 it('1. Custo 20 vendido 40',()=>{const r=calculatePricing(base);expect(r.netProfit).toBe(20);expect(r.realMarginPct).toBe(50)})
 it('2. Frete e embalagem',()=>{const r=calculatePricing({...base,cost:20,freight:5,packaging:3});expect(r.netProfit).toBe(12);expect(r.costTotal).toBe(28)})
 it('3. Taxa % + fixa',()=>{const r=calculatePricing({...base,marketplacePct:10,fixedFee:2});expect(r.totalFees).toBe(6);expect(r.netProfit).toBe(14)})
 it('4. Margem negativa',()=>{const r=calculatePricing({...base,salePrice:10});expect(r.netProfit).toBeLessThan(0);expect(r.realMarginPct).toBeLessThan(0)})
 it('5. Margem desejada 20%',()=>{const r=calculatePricing({...base,desiredMarginPct:20});expect(r.suggestedPrice).toBe(25)})
 it('5b. Sugestão com taxas: (20+2)/(1-0.10-0.20)=31.43',()=>{const r=calculatePricing({...base,marketplacePct:10,fixedFee:2,desiredMarginPct:20});expect(r.suggestedPrice).toBeCloseTo(31.43,1)})
 it('6. Sem lucro',()=>{const r=calculatePricing({...base,salePrice:20});expect(r.netProfit).toBe(0)})
 it('7. Custos altos',()=>{const r=calculatePricing({...base,cost:100,freight:50});expect(r.netProfit).toBe(-110)})
 it('8. Percentuais inválidos',()=>{expect(validatePricing({...base,taxPct:60,marketplacePct:50,desiredMarginPct:20}).length).toBeGreaterThan(0); expect(calculatePricing({...base,taxPct:90,marketplacePct:20}).valid).toBe(false)})
 it('9. Marketplaces diferentes',()=>{const a=calculatePricing({...base,marketplacePct:5});const b=calculatePricing({...base,marketplacePct:15});expect(a.netProfit).toBeGreaterThan(b.netProfit)})
 it('10. Negativos rejeitados',()=>{expect(validatePricing({...base,cost:-5}).length).toBeGreaterThan(0)})
})
