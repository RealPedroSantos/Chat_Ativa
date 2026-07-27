-- Impede que clientes da API invoquem o gatilho administrativo de RLS.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

-- Índices para as chaves estrangeiras e filtros por empresa.
create index idx_canned_responses_tenant on public.canned_responses (tenant_id);
create index idx_knowledge_tenant on public.knowledge (tenant_id);
create index idx_rules_tenant on public.rules (tenant_id);
create index idx_users_tenant on public.users (tenant_id);
create index idx_history_imports_tenant on public.history_imports (tenant_id);
create index idx_history_imports_imported_by on public.history_imports (imported_by);
create index idx_appointments_created_by on public.appointments (created_by);
create index idx_conversation_cycles_assigned_user
  on public.conversation_cycles (assigned_user_id);
create index idx_conversation_cycles_opened_by
  on public.conversation_cycles (opened_by);
create index idx_conversation_cycles_resolved_by
  on public.conversation_cycles (resolved_by);
create index idx_internal_messages_sender on public.internal_messages (sender_id);
create index idx_internal_messages_recipient on public.internal_messages (recipient_id);
create index idx_internal_notes_author on public.internal_notes (author_id);
