// Planos do NoAzul — edite aqui o link real da Cakto antes de vender.
export const PRO_PRICE_BRL = 10
export const PRO_PERIOD_LABEL = 'mês'
export const PRO_PRODUCT_NAME = 'NoAzul Pro'

/** Link de checkout da Cakto (produto de assinatura mensal de R$ 10). */
export const CAKTO_CHECKOUT_URL = 'https://pay.cakto.com.br/ms6ggef_1287994'
export const isCheckoutConfigured = (url?: string | null) => Boolean(url && url.trim() && !url.includes('SEU-PRODUTO'))
export const getCheckoutUrl = (saved?: string | null) => (saved && saved.trim()) || CAKTO_CHECKOUT_URL

/** URL do servidor de licenças (Worker). Dono: configure em Ajustes ou aqui. */
export const LICENSE_API_URL = 'https://noazul-license.noazul.workers.dev'
export const getLicenseApiUrl = (saved?: string | null) => (saved && saved.trim()) || LICENSE_API_URL
export const isLicenseApiConfigured = (url?: string | null) => Boolean(url && url.trim() && !url.includes('SEU-SUBDOMINIO'))

export const FREE_LIMITS = { goals: 3, recurrences: 3 } as const

export const PRO_FEATURES = [
  { title: 'Resumo anual avançado', desc: 'Comparativo com o ano anterior, média por mês e categoria mais gastada no ano' },
  { title: 'Nota de organização financeira', desc: 'Score 0–100 com dicas do que melhorar' },
  { title: 'Análise inteligente de gastos', desc: 'Tendência dos últimos meses e onde cortar primeiro' },
  { title: 'Metas que guardam sozinhas', desc: 'Aporte automático todo mês para sua meta' },
  { title: 'Exportar em Excel e PDF anual', desc: 'Relatórios completos para abrir no Excel ou imprimir' },
  { title: 'Metas e recorrências ilimitadas', desc: 'Na versão grátis: até 3 metas e 3 recorrências' },
  { title: 'Temas premium', desc: 'Cores roxa, azul e âmbar para deixar o app com a sua cara' },
] as const

export const FREE_FEATURES = [
  'Entradas e saídas ilimitadas',
  'Contas fixas com paga/pendente',
  'Limites por categoria',
  'Resumo do mês e gráfico dos últimos 12 meses',
  'Resumo anual básico',
  'Até 3 metas e 3 recorrências',
  'Cópia dos dados (backup)',
] as const
