# OpenSubtitles REST API v1 Reference

## Overview

The OpenSubtitles REST API (`https://api.opensubtitles.com/api/v1`) replaces the legacy OpenSubtitles.org XML-RPC system with a faster, scalable JSON REST interface for searching and downloading subtitles by movie hash, IMDb ID, title, or TV season/episode.

## Account, API Key & Quotas

1. **Create an Account**: Register at [opensubtitles.com](https://www.opensubtitles.com/en/users/sign_up) (or import a legacy OpenSubtitles.org account).
2. **Create an API Key**: Generate a consumer key in the [API Consumers](https://www.opensubtitles.com/en/consumers) section of your profile.
3. **Quotas & Limits**:
   - **Searching**: No daily search limit.
   - **Anonymous downloads** (API key only, no login): Up to **5 downloads per 24 hours per IP**.
   - **Authenticated free account** (API key + `/login` JWT): Up to **20 downloads per day** (varies by user rank, up to **1,000/day** for VIP users).
   - **Pro packages**: Higher/unlimited download quotas without requiring user login credentials.

## Mandatory Headers & Best Practices

Every request to `api.opensubtitles.com` must include:

- `Api-Key: <YOUR_API_KEY>`
- `User-Agent: <AppName vVersion>` (for example, `plex-video-organizer v1.0`)
- `Accept: application/json` (and `Content-Type: application/json` for `POST` bodies)

Additional best practices:

- Follow HTTP redirects (`--location` in cURL).
- Send `GET` query parameters in alphabetical order and encode spaces with `+`.

## Authentication & Download Flow

### 1. Search Subtitles (`GET /api/v1/subtitles`)

```bash
curl --location --request GET 'https://api.opensubtitles.com/api/v1/subtitles?imdb_id=tt0133093&languages=es,ea' \
  -H "Content-Type: application/json" \
  -H "Api-Key: <YOUR_API_KEY>" \
  -A "User-Agent: plex-video-organizer v1.0"
```

### 2. Optional User Login (`POST /api/v1/login`)

When `OPENSUBTITLES_USERNAME` and `OPENSUBTITLES_PASSWORD` are configured in `.env`, `openSubtitlesRestProvider.ts` authenticates to obtain a JWT `token` and optional user-specific `base_url` (for VIP routing):

```json
{
  "username": "<OPENSUBTITLES_USERNAME>",
  "password": "<OPENSUBTITLES_PASSWORD>"
}
```

### 3. Request Download Link (`POST /api/v1/download`)

Pass `file_id` from the search response, along with `Api-Key` and (when logged in) `Authorization: Bearer <token>`, to receive a temporary direct `link` for the `.srt` file.

## Project Configuration (`.env`)

- `OPENSUBTITLES_API_KEY`: Enables the official OpenSubtitles REST v1 provider alongside the keyless providers (`opensubtitles-stremio`, `gestdown`, `yify`, `podnapisi`).
- `OPENSUBTITLES_USERNAME` / `OPENSUBTITLES_PASSWORD`: Optional credentials to authenticate via `/api/v1/login` and unlock account download quotas (automatically refreshing the JWT on `401`).
