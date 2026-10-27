/*
 * 京东店铺签到 token 抓取
 * 打开店铺签到页面（h5.m.jd.com/babelDiy/Zeus/2PAAf74aG3D61qvfKUM5dxUssJQ9/index.html?token=xxx）时
 * 自动记录 token，去重后保存在 Surge 本地；填写了青龙参数时同步写入青龙环境变量 jd_dpqd_tokens。
 *
 * 模块参数（$argument）：ql_url=http://192.168.1.x:5700&client_id=xxx&client_secret=xxx&max=60（值为 none 视为未填）
 */

const STORE_KEY = 'jd_dpqd_tokens';
const ENV_NAME = 'jd_dpqd_tokens';

const args = Object.fromEntries(
  ($argument || '')
    .split('&')
    .map((kv) => kv.split('='))
    .filter(([k, v]) => k && v && v !== 'none' && !v.startsWith('{{{'))
    .map(([k, v]) => [k.trim(), decodeURIComponent(v.trim())])
);
const MAX = parseInt(args.max, 10) || 60;

const match = $request.url.match(/[?&]token=([^&#]+)/);
if (!match) {
  $done({});
} else {
  main(decodeURIComponent(match[1])).finally(() => $done({}));
}

async function main(token) {
  const saved = ($persistentStore.read(STORE_KEY) || '').split(',').filter(Boolean);
  if (saved.includes(token)) return;

  // 新的放最前，超过上限丢弃最旧的（过期活动会自然被挤出去）
  const tokens = [token, ...saved].slice(0, MAX);
  $persistentStore.write(tokens.join(','), STORE_KEY);

  let qlResult = '未配置青龙，已保存在本地';
  if (args.ql_url && args.client_id && args.client_secret) {
    try {
      await syncToQinglong(tokens.join(','));
      qlResult = '已同步到青龙';
    } catch (e) {
      qlResult = `同步青龙失败：${e}`;
    }
  }
  $notification.post('店铺签到 token +1', `共 ${tokens.length} 个｜${qlResult}`, token);
}

function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      url: args.ql_url.replace(/\/$/, '') + path,
      headers: { 'Content-Type': 'application/json' },
      timeout: 8,
    };
    if (token) opts.headers.Authorization = `Bearer ${token}`;
    if (body) opts.body = JSON.stringify(body);
    const fn = method === 'GET' ? $httpClient.get : method === 'PUT' ? $httpClient.put : $httpClient.post;
    fn(opts, (err, resp, data) => {
      if (err) return reject(err);
      try {
        const json = JSON.parse(data);
        json.code === 200 ? resolve(json.data) : reject(json.message || data);
      } catch (e) {
        reject(`HTTP ${resp && resp.status}`);
      }
    });
  });
}

async function syncToQinglong(value) {
  const { token } = await request(
    'GET',
    `/open/auth/token?client_id=${encodeURIComponent(args.client_id)}&client_secret=${encodeURIComponent(args.client_secret)}`
  );
  const envs = await request('GET', `/open/envs?searchValue=${ENV_NAME}`, { token });
  const existing = (envs || []).find((e) => e.name === ENV_NAME);
  if (existing) {
    // 合并青龙里手动加的 token，避免覆盖
    const merged = [...new Set([...value.split(','), ...existing.value.split(',')].filter(Boolean))].slice(0, MAX);
    await request('PUT', '/open/envs', {
      token,
      body: { id: existing.id ?? existing._id, name: ENV_NAME, value: merged.join(','), remarks: existing.remarks || '店铺签到（Surge 自动抓取）' },
    });
  } else {
    await request('POST', '/open/envs', {
      token,
      body: [{ name: ENV_NAME, value, remarks: '店铺签到（Surge 自动抓取）' }],
    });
  }
}
