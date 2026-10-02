// VitePress 自行创建 HTTP 服务，不消费 vite.server.proxy；
// 用一个极简中间件插件把 /api 转发到内容 API（默认 :5174）。
import type { Plugin } from 'vite'
import http from 'node:http'

export function i18nApiProxy(targetPort = 5174): Plugin {
  return {
    name: 'i18n-api-proxy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/') && req.url !== '/api') return next()
        const proxyReq = http.request(
          {
            port: targetPort,
            path: req.url,
            method: req.method,
            headers: { ...req.headers, host: `localhost:${targetPort}` }
          },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
            proxyRes.pipe(res)
          }
        )
        proxyReq.on('error', () => {
          res.writeHead(502, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { code: 'api-down', message: '内容 API 未启动，前端将回退到构建快照' } }))
        })
        req.pipe(proxyReq)
      })
    }
  }
}
