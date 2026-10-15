# Repository rules

## MikroORM migrations

- Never create a migration file manually.
- Every migration must be created with the appropriate MikroORM migration command:
  - `npm run migration:create:sqlite`
  - `npm run migration:create:pg`
- Do not replace generated schema SQL with handwritten SQL.
- Keep SQLite and PostgreSQL migrations separate and use the matching driver command for each.
- Do not manually edit migration snapshots. Regenerate them through MikroORM when schema changes require snapshot updates.
- If the change cannot be represented by MikroORM metadata, notify the user.
- Before finishing migration work, run type-checking and validate the migration against the relevant database driver when available.

## Database triggers

- Keep triggers modular and database-specific. Use files such as `src/database/triggers/audit.sqlite3.triggers.ts` and `src/database/triggers/audit.postgresql.triggers.ts`.
- Select trigger definitions from the configured database driver through MikroORM configuration.
- Keep trigger metadata separate from entity schema definitions where practical, so schemas and triggers can later move into separate module folders without restructuring the database configuration.
- Never hand-edit migration DDL for triggers. Define triggers in MikroORM metadata and regenerate the matching driver migration.

## Management commands

- Use `nest-commander` for management commands.
- Keep command implementations scoped to their owning module, and expose them through that module's command module.
- Register module command modules explicitly from `src/commands/commands.module.ts`; nest-commander does not autodiscover command classes.
