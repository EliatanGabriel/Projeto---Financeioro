export interface PricingInputs{
  name:string; cost:number; freight:number; packaging:number; otherCosts:number;
  taxPct:number; marketplacePct:number; paymentPct:number; fixedFee:number;
  desiredMarginPct:number; salePrice:number;
}
export interface PricingResult{
  fixedCostsTotal:number; totalFees:number; costTotal:number;
  suggestedPrice:number; minPrice:number; netProfit:number;
  realMarginPct:number; roiPct:number; markupPct:number; valid:boolean; errors:string[];
  taxValue:number; marketplaceValue:number; paymentValue:number;
}
export interface Product{id:string;name:string;cost:number;freight:number;packaging:number;otherCosts:number;category:string;createdAt:string;updatedAt:string;salePrice:number;desiredMarginPct:number;marketplace:string}
export interface Marketplace{id:string;name:string;commissionPct:number;paymentPct:number;fixedFee:number;taxPct:number;isDefault:boolean;note:string;createdAt:string}
export interface Scenario{id:string;label:string;price:number}
export interface LicenseInfo{key:string; holder:string; deviceId:string; issuedAt:string; expiresAt:string|null; plan:'lifetime'; signature:string}
export interface AppSettings{companyName:string;companyCnpj:string;currency:string;theme:'light'|'dark';rounding:'cent'|'up2';activated:boolean;licenseKey:string;deviceId:string}
export type TxType = 'in' | 'out'
export interface Transaction { id: string; userId?: string; description: string; amount: number; type: TxType; category: string; date: string; note?: string; createdAt: string }
export interface FixedBill { id: string; userId?: string; name: string; amount: number; dueDay: number; category: string; createdAt: string }
export interface Goal { id: string; userId?: string; name: string; target: number; saved: number; deadline?: string; createdAt: string; autoMonthly?: number }
export interface ProState { activated: boolean; holder: string; expiresAt: string | null; plan: string; key: string }
export type InvestmentCategory = 'Renda fixa' | 'Poupança' | 'Ações' | 'Fundos imobiliários' | 'ETFs' | 'Fundos de investimento' | 'Criptomoedas' | 'Outros'
export type InvestmentTxType = 'compra' | 'aporte' | 'venda' | 'resgate' | 'dividendo' | 'rendimento'
export interface Investment { id: string; userId: string; name: string; category: string; ticker: string; institution: string; quantity: number; averagePrice: number; investedAmount: number; currentValue: number; startedAt: string; notes: string; createdAt: string; updatedAt: string }
export interface InvestmentTransaction { id: string; investmentId: string; userId: string; type: InvestmentTxType; quantity: number; unitPrice: number; amount: number; date: string; description: string; createdAt: string; costRemoved?: number; realizedGain?: number }
export interface Budget { category: string; limit: number; userId?: string }
export interface BillPayment { billId: string; month: string; paidAt: string; userId?: string }
export interface Recurrence { id: string; userId?: string; description: string; amount: number; type: TxType; category: string; day: number; active: boolean; createdAt: string }
export interface Category { name: string; type: TxType; userId?: string }
export interface CreditCard { id: string; userId?: string; name: string; brand: string; limitAmount: number; closingDay: number; dueDay: number; color: string; createdAt: string; updatedAt?: string }
export interface CreditCardPurchase { id: string; userId?: string; cardId: string; description: string; category: string; totalAmount: number; installments: number; firstDate: string; notes?: string; createdAt: string; updatedAt?: string }
export interface CreditCardPayment { cardId: string; month: string; paidAt: string; userId?: string }
