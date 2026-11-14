# Purpose

Project documentation, design blueprints, and official Plex media preparation references.

## Ownership

Project Maintainers.

## Local Contracts

- All authored project documentation must be written in English (`'en'`).
- Official Plex reference articles under [plex/](plex/) are preserved verbatim as source-of-truth specifications.

## Key Files

- [designs/plex-video-organizer.md](designs/plex-video-organizer.md): Approved architecture and implementation blueprint.
- [opensubtitles-api.md](opensubtitles-api.md): OpenSubtitles REST API v1 authentication, headers, quotas, and `.env` configuration guide.

## Work Guidance

- Keep [designs/plex-video-organizer.md](designs/plex-video-organizer.md) aligned with implemented Plex naming and subtitle rules.

## Verification

- Run `npm run auditor:lint` after editing documentation.
