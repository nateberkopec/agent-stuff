When implementing or editing code:

Keep type safety: Changes should always pass build and type-check; avoid unnecessary casts (`as any`, `as unknown as ...`); prefer proper types and guards, and reuse existing helpers (e.g., normalizing identifiers) instead of type-asserting.
