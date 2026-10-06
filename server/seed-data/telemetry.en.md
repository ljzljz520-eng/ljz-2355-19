# Telemetry Configuration

Telemetry is disabled by default. You can enable it via an environment variable or the config file.

Once enabled, the SDK reports anonymous usage data every hour. The data never includes your source code or personal information.

## How to Enable

Set the environment variable `MYLIB_TELEMETRY=1` to enable it.

```bash
export MYLIB_TELEMETRY=1
```

The `interval` parameter controls the reporting interval, in seconds.
