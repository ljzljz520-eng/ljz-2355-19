# 遥测配置

遥测功能默认关闭。你可以通过环境变量或配置文件开启，开启后 SDK 会每小时上报一次匿名使用数据，数据不包含任何源码或个人信息。

## 开启方式

设置环境变量 `MYLIB_TELEMETRY=1` 即可开启。

```bash
export MYLIB_TELEMETRY=1
```

参数 `interval` 控制上报间隔，单位为秒。
