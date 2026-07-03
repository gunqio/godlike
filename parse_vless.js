#!/usr/bin/env node
/**
 * parse_vless.js
 * 将 VLESS 链接解析成 Xray-core 配置文件（JSON），输出到 stdout。
 *
 * 用法：node parse_vless.js "vless://..." > /tmp/xray_config.json
 *
 * 支持两种格式：
 *   1. VLESS + REALITY + TCP（xtls-rprx-vision）
 *      vless://UUID@host:port?security=reality&flow=xtls-rprx-vision&sni=...&pbk=...&sid=...&...
 *
 *   2. VLESS + TLS + WebSocket
 *      vless://UUID@host:port?security=tls&type=ws&host=...&path=...&sni=...&...
 *
 * 本地暴露：Socks5 127.0.0.1:10808
 */

const vlessLink = process.argv[2] || process.env.VLESS_LINK || '';

if (!vlessLink || !vlessLink.startsWith('vless://')) {
  process.stderr.write('❌ 未提供有效的 VLESS 链接，请通过参数或 VLESS_LINK 环境变量传入。\n');
  process.exit(1);
}

function parseVless(link) {
  // vless://UUID@host:port?params#remark
  const withoutScheme = link.slice('vless://'.length);
  const hashIdx = withoutScheme.indexOf('#');
  const withoutHash = hashIdx >= 0 ? withoutScheme.slice(0, hashIdx) : withoutScheme;

  const atIdx = withoutHash.indexOf('@');
  const uuid = withoutHash.slice(0, atIdx);
  const rest = withoutHash.slice(atIdx + 1);

  const qIdx = rest.indexOf('?');
  const hostPort = qIdx >= 0 ? rest.slice(0, qIdx) : rest;
  const queryStr = qIdx >= 0 ? rest.slice(qIdx + 1) : '';

  // 支持 IPv6 [::1]:port 格式
  let host, port;
  if (hostPort.startsWith('[')) {
    const closeBracket = hostPort.indexOf(']');
    host = hostPort.slice(1, closeBracket);
    port = parseInt(hostPort.slice(closeBracket + 2), 10);
  } else {
    const colonIdx = hostPort.lastIndexOf(':');
    host = hostPort.slice(0, colonIdx);
    port = parseInt(hostPort.slice(colonIdx + 1), 10);
  }

  const params = {};
  for (const pair of queryStr.split('&')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 0) continue;
    const k = decodeURIComponent(pair.slice(0, eqIdx));
    const v = decodeURIComponent(pair.slice(eqIdx + 1));
    params[k] = v;
  }

  return { uuid, host, port, params };
}

function buildConfig(parsed) {
  const { uuid, host, port, params } = parsed;
  const security = (params.security || 'none').toLowerCase();
  const network = (params.type || 'tcp').toLowerCase();
  const flow = params.flow || '';

  // ===== 构造 streamSettings =====
  let streamSettings = { network };

  // TLS
  if (security === 'tls') {
    streamSettings.security = 'tls';
    streamSettings.tlsSettings = {
      serverName: params.sni || host,
      allowInsecure: params.allowInsecure === '1' || params.insecure === '1',
    };
  }

  // REALITY
  if (security === 'reality') {
    streamSettings.security = 'reality';
    streamSettings.realitySettings = {
      serverName: params.sni || host,
      fingerprint: params.fp || 'chrome',
      publicKey: params.pbk || '',
      shortId: params.sid || '',
      spiderX: params.spx || '',
    };
  }

  // WebSocket
  if (network === 'ws') {
    streamSettings.wsSettings = {
      path: params.path || '/',
      headers: {
        Host: params.host || host,
      },
    };
  }

  // TCP（headerType=http 情况，一般很少见，保留兜底）
  if (network === 'tcp' && params.headerType === 'http') {
    streamSettings.tcpSettings = {
      header: { type: 'http' },
    };
  }

  // ===== 构造 outbound =====
  const outbound = {
    protocol: 'vless',
    settings: {
      vnext: [
        {
          address: host,
          port,
          users: [
            {
              id: uuid,
              encryption: 'none',
              ...(flow ? { flow } : {}),
            },
          ],
        },
      ],
    },
    streamSettings,
  };

  // ===== 完整 xray 配置 =====
  return {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        port: 10808,
        listen: '127.0.0.1',
        protocol: 'socks',
        settings: {
          auth: 'noauth',
          udp: true,
        },
        tag: 'socks-in',
      },
      {
        port: 10809,
        listen: '127.0.0.1',
        protocol: 'http',
        settings: {},
        tag: 'http-in',
      },
    ],
    outbounds: [
      { ...outbound, tag: 'proxy' },
      { protocol: 'freedom', tag: 'direct' },
      { protocol: 'blackhole', tag: 'block' },
    ],
    routing: {
      domainStrategy: 'IPIfNonMatch',
      rules: [
        {
          type: 'field',
          outboundTag: 'direct',
          ip: ['geoip:private'],
        },
      ],
    },
  };
}

try {
  const parsed = parseVless(vlessLink);
  const config = buildConfig(parsed);
  process.stdout.write(JSON.stringify(config, null, 2) + '\n');
  process.stderr.write(
    `✅ 已解析 VLESS 节点: ${parsed.host}:${parsed.port} (security=${parsed.params.security || 'none'}, type=${parsed.params.type || 'tcp'})\n`
  );
} catch (e) {
  process.stderr.write('❌ 解析 VLESS 链接失败: ' + e.message + '\n');
  process.exit(1);
}
