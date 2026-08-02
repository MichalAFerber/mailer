// The §13 fixture: one document exercising every component in the catalog.
// Used by /preview and by the golden test, so the two cannot drift.
export const FIXTURE = {
  brand: {
    name: 'ops',
    logoUrl: 'https://mailer.thompsonblack.us/icon-192.png',
    accent: '#a8322a',
    footerNotice: 'Sent by ops from noreply@thompsonblack.us. Add that address to your contacts so this keeps landing in the inbox.',
    footerPostal: 'ThompsonBlack LLC · PO Box 3071, Florence SC 29502',
  },
  subject: 'Backup audit — Wasabi offsite is stale',
  preheader: 'pve-ubuntu-001 and r2d2 are past the 50h window. Everything else is current.',
  eyebrow: 'Backup audit',
  signoff: 'us.tgwab.backup-audit · 2026-08-02 09:01 UTC',
  markdown: `# Wasabi offsite is stale

> [!CAUTION] Two hosts past the 50h threshold
> Their last successful tarball predates the window. Treat offsite copies for these two as unavailable until a run completes.

## Affected hosts {bad}

| Host | Age | Status |
|---|---|---|
| pve-ubuntu-001 | 61.4h | bad |
| r2d2 | 54.9h | bad |

## What to check

Both hosts are on the same nightly cron. Fleet-wide failure is more likely than two independent ones — check the [rclone credentials](https://ipcow.com/dashboard) first.

- Wasabi access key rotation date
- Free space on \`/srv/backups\`
- Whether the tarball step exited before upload

\`\`\`
journalctl -u backup-offsite.service --since -3d
\`\`\`

[Open Gatus](https://gatus.thompsonblack.us){btn}
`,
};
