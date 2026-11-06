import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'

const schema = readFileSync(new URL('../../supabase/migrations/0001_schema.sql', import.meta.url), 'utf8')
const rls = readFileSync(new URL('../../supabase/migrations/0002_rls_policies.sql', import.meta.url), 'utf8')
const envExample = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8')
const docs = readFileSync(new URL('../../docs/SUPABASE.md', import.meta.url), 'utf8')

const PRIVATE_TABLES = ['transactions','fixed_bills','goals','budgets','bill_payments','recurrences','recurrence_launches','categories','goal_auto_launches','investments','investment_transactions','profiles']

describe('supabase — schema e RLS (estrutural, sem banco real)', () => {
  it('todas as tabelas privadas existem com PK, user_id e colunas de sync', () => {
    for (const t of PRIVATE_TABLES) {
      expect(schema, t).toContain(`create table public.${t} `)
    }
    for (const col of ['user_id uuid not null references auth.users', 'created_at timestamptz', 'updated_at timestamptz', 'version integer', 'deleted_at timestamptz']) {
      expect(schema, col).toBeTruthy()
    }
    expect(schema).not.toContain('service_role')
    expect(schema).toContain('unique (id, user_id)')
    expect(schema).toContain('investment_transactions_owner_fk')
  })
  it('todas as tabelas privadas têm RLS habilitada e 4 políticas por tabela', () => {
    for (const t of PRIVATE_TABLES) {
      expect(rls, t).toContain(`alter table public.${t} enable row level security`)
      for (const op of ['select','insert','update','delete']) {
        expect(rls, `${t} ${op}`).toContain(`create policy ${t}_${op} on public.${t} for ${op}`)
      }
    }
    expect(rls).not.toContain('service_role')
    expect(rls.match(/auth\.uid\(\) = user_id/g)?.length).toBeGreaterThanOrEqual(40)
  })
  it('nenhuma tabela legada de licenciamento/precificação é sincronizada', () => {
    expect(schema).not.toContain('create table public.products')
    expect(schema).not.toContain('create table public.app_settings')
    expect(schema).not.toContain('create table public.marketplaces')
  })
  it('.env.example sem credenciais reais e sem service_role no frontend', () => {
    expect(envExample).toContain('VITE_SUPABASE_URL=https://SEU-PROJETO.supabase.co')
    expect(envExample).toContain('VITE_SUPABASE_ANON_KEY=')
    expect(envExample).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/)
    expect(envExample).not.toMatch(/^VITE_.*SERVICE_ROLE/m)
    expect(existsSync(new URL('../../.env.local', import.meta.url))).toBe(false)
  })
  it('documentação cobre setup, mapeamento e licenciamento separado', () => {
    for (const s of ['supabase.com', 'Project Settings', 'Row Level Security', 'auth.users', 'deleted_at']) expect(docs).toContain(s)
    expect(docs.toLowerCase()).toContain('licenciamento')
  })
})
