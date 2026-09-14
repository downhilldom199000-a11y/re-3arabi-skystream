# re-3arabi → SkyStream

Full multi-provider SkyStream Gen 2 port project based on the uploaded `Abodabodd/re-3arabi` CloudStream sources.

## Providers

This repository contains 39 provider folders, each with `plugin.json` and `plugin.ts`.

## Repository URL

`https://raw.githubusercontent.com/downhilldom199000-a11y/skystream-3isk/main/repo.json`

## Build

GitHub Actions runs the official SkyStream CLI deployment command and commits the generated `dist/*.sky` packages back to `main`.

The provider ports are generated translations of the supplied CloudStream sources. Some providers may require additional runtime fixes because CloudStream and SkyStream have different APIs and some source providers use site-specific, WebView, anti-bot, or extractor behavior.

Use the SkyStream developer test commands for each provider: `getHome`, `search`, `load`, and `loadStreams`.

Only use sources/content you are legally permitted to access.
