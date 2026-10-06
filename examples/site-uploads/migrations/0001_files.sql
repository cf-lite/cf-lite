-- Metadata for every uploaded object; the bytes live in R2.
create table files (
  key text primary key,
  size integer not null,
  content_type text not null,
  etag text not null,
  created_at integer not null default (unixepoch())
);
