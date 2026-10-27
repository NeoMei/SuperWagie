# Linux Updater E2E Fixture

This local-only harness verifies AppImage N-to-N+1 replacement without changing the
production GitHub updater provider. It supports native x64 and arm64 hosts.

1. Build both versions on the native target architecture. For N and N+1, set the
   test-build marker only while bundling main, then complete normal packaging:

   ```bash
   OPENCHAMBER_TARGET_ARCH=x64 OPENCHAMBER_UPDATER_E2E_BUILD=1 bun run bundle:main
   OPENCHAMBER_TARGET_ARCH=x64 node ./scripts/package.mjs --linux --x64 --publish=never
   ```

   Use `OPENCHAMBER_TARGET_ARCH=arm64` and `--arm64` on an arm64 host. Keep the N and
   N+1 AppImages in separate output directories before rebuilding.

2. Launch N against a loopback fixture containing N+1:

   ```bash
   bun run updater:e2e:fixture -- run \
     --arch x64 \
     --current /absolute/path/OpenChamber-N-linux-x86_64.AppImage \
     --next /absolute/path/OpenChamber-N+1-linux-x86_64.AppImage \
     --version N+1 \
     --dir /tmp/openchamber-updater-e2e
   ```

3. In N, check for updates, download/install, and restart. Verify the restarted app
   reports N+1 and that the file at `APPIMAGE` was replaced. Repeat with `--arch arm64`
   and the arm64 AppImages on the arm64 host.

The harness binds only `127.0.0.1`. Runtime override activation additionally requires
`OPENCHAMBER_E2E=1`, the loopback URL set by the harness, and the build-time marker.
Normal packages omit the build-time marker and always use the SuperWagie production feed.
The renderer, IPC bridge, command-line arguments, and persistent configuration do not
have access to the feed URL.

## Windows x64 staging

Windows uses the same gated loopback provider with its dedicated
`latest-x64.yml` channel. Stage an installer without executing it:

```bash
bun run updater:e2e:fixture -- stage \
  --platform win32 --arch x64 \
  --next /absolute/path/SuperWagie-next-win-x64.exe \
  --version next-version --dir /tmp/superwagie-windows-updater-e2e
```

Serve that directory with the `serve` command. Start the isolated Windows test
app with the three documented build/runtime gates. The fixture writes no
legacy `latest.yml`, so a missing channel cannot quietly test the old feed.
Windows ARM64 staging is refused. An actual NSIS installation and restart must
be accepted separately on Windows.
