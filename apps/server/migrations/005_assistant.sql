-- AI assistant chat. Each person has their own conversation. The assistant never
-- saves bills, stock or money itself: it proposes "cards" that a person confirms
-- through the normal screens and permission checks.
create table assistant_messages (
  id bigserial primary key,
  user_id int not null references users(id),
  device_id int references devices(id),
  at timestamptz not null default now(),
  role text not null check (role in ('user', 'assistant')),
  text text not null default '',
  -- What the assistant heard in a voice note (shown under the note).
  heard text,
  -- [{kind: 'image'|'audio'|'pdf', mimeType, file}]
  files jsonb not null default '[]',
  -- Proposed actions: [{kind, status: 'proposed'|'done'|'dismissed', ...}]
  cards jsonb not null default '[]',
  error text,
  -- "Clear chat" hides messages; nothing is deleted.
  hidden boolean not null default false
);
create index assistant_messages_user on assistant_messages (user_id, id);
