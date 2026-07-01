require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3456;
const API_KEY = process.env.DEEPSEEK_API_KEY;
const API_TIMEOUT_MS = 15000;
const ROOT_DIR = __dirname;
const PATTERN_TITLE_FALLBACK_LENGTH = 30;

const SYSTEM_PROMPT = `你是一个模式识别工具，不是心理医生。你只负责从事件记录中提取关键词、互动模式和关系变化趋势。

严格遵守：
- 只描述重复出现的行为模式与关系变化，不做任何心理诊断
- 不给任何建议，不评价你或他人
- 不贴任何标签（如NPD、讨好型人格等）
- 使用客观、中性、温和的语言
- 一律用「你」指代记录者，禁止出现「用户」这个词
- 必须仅用 JSON 格式返回，不要输出任何其他文字

返回 JSON 结构：
{
  "keywords": ["5-8个关键词"],
  "patterns": [
    {
      "title": "模式标题",
      "description": "模式展开描述"
    }
  ],
  "relationshipSummary": "关系变化简介，不超过150字，无足够信息可返回空字符串",
  "eventEmotions": [
    { "recordId": "与输入记录ID一致", "emotionWord": "简短情绪词，无法提炼则填未记录" }
  ],
  "turningPoints": [
    {
      "description": "一句话描述转折，说明在何时前后、因何情况、态度或行为如何变化",
      "recordIds": ["相关事件记录ID，可1条或多条"]
    }
  ],
  "associationPatterns": [
    "在感到……的时候，你常常会联想到……"
  ]
}

patterns 字段要求（非常重要）：
- 如未发现足够模式则返回空数组
- 每个 pattern 必须同时包含 title 和 description，且 description 不得照抄 title
- 为每个识别出的互动模式生成一个简短的概括性标题，直接点明模式核心，不要使用编号
- 每个模式标题必须在25字以内，且必须是一句语义完整的话。标题要高度凝练，直击模式核心
- 标题格式示例：「无效的争吵：表达不满→被反击→沉默收场」
- 禁止使用「模式1」「模式2」「互动模式1」等编号作为 title
- description 必须基于你写下的具体事件内容展开，提供信息增量与事实证据
- description 示例：「在你记录的3次事件中，有2次出现了这样的结构：你表达不满→对方反击→最终以沉默结束。你在其中一次提到对方说'随便你'后不再回复。」
- description 中应引述记录里的具体细节作为佐证

turningPoints 字段要求（转折点分析，非常重要）：
- 请分析用户与当前分析对象的所有事件记录，识别用户在态度或行为上发生明显变化的时刻
- 转折点可以是：
  1. 态度变化：如从信任变为怀疑、从忍耐变为反抗、从期待变为失望、或从回避变为主动
  2. 行为变化：如从被动回应变为主动分享、从沉默变为表达、从哄对方变为不再哄
  3. 转折不限于「变差」，也包括「变好」或「尝试改变」
- 请为每个识别到的转折点，用一句话描述：在[时间]前后，因为[什么情况]，你的[什么态度/行为]发生了变化
- 描述示例：
  「在5月9日的事件后，你首次给这段关系打了最低分1分，这可能是你态度从『困惑』转向『确认伤害』的时刻。」
  「在6月中旬，你开始主动分享照片给对方，这可能表明你的行为从被动回应转向了主动尝试连接或验证。」
- 每个 turningPoint 必须包含 description 和 recordIds
- recordIds 为与该转折最相关的1条或多条事件记录ID，必须来自输入，不要编造
- 基于事件语义分析，不要仅因评分变化机械判定；评分仅作辅助参考
- 无明显转折则返回空数组

associationPatterns 字段要求（联想模式分析，非常重要）：
- 请分析用户提供的所有事件记录中的「联想」内容（「联想到过去的事情或脑海中的画面」字段，以及事件背景中提及的关联画面或经历）
- 找出其中反复出现的、具有共性的主题或模式。例如，用户是否在不同情境下，反复联想到同一个人（如父亲、母亲）、同一件事（如童年经历）、或同一种感受（如被抛弃感）
- 将这些发现提炼为几个核心的「联想模式」，每条用「在感到……的时候，你常常会联想到……」的句式来表述
- 不要罗列原文，只做语义提炼与归纳
- 如果联想内容没有共性，或有效联想内容太少无法归纳，返回空数组（不要返回「未发现明显的联想模式」等说明文字）

其他：
- relationshipSummary 只描述关系变化趋势，只陈述事实，用「你」指代记录者
- eventEmotions 需覆盖输入中的每条事件记录
- keywords 返回 5-8 个`;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(payload));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sanitizeSecondPerson(text) {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/用户/g, '你').trim();
}

function isGenericPatternTitle(title) {
  if (!title) return true;
  const t = String(title).trim();
  return /^(互动)?模式\s*[\d一二三四五六七八九十]+$/.test(t);
}

function resolvePatternTitle(rawTitle, rawDescription) {
  const title = sanitizeSecondPerson(rawTitle);
  if (title) return title;

  const description = sanitizeSecondPerson(rawDescription);
  return description ? description.slice(0, PATTERN_TITLE_FALLBACK_LENGTH) : '';
}

function readPatternFields(item) {
  if (!item || typeof item !== 'object') {
    return { title: '', description: '' };
  }
  return {
    title: item.title || item.name || item.label || item['标题'] || '',
    description: item.description || item.desc || item.text || item.detail || item['描述'] || '',
  };
}

function normalizePatternItem(item) {
  if (typeof item === 'string' && item.trim()) {
    const text = sanitizeSecondPerson(item.trim());
    return {
      title: resolvePatternTitle('', text),
      description: text,
    };
  }
  if (!item || typeof item !== 'object') return null;

  const fields = readPatternFields(item);
  const description = sanitizeSecondPerson(fields.description);
  const title = resolvePatternTitle(fields.title, description);
  if (!title && !description) return null;
  return {
    title,
    description: description || title,
  };
}

function normalizeTurningPointItem(item) {
  if (!item || typeof item !== 'object') return null;
  const description = sanitizeSecondPerson(item.description || item.summary || item.title || '');
  if (!description) return null;

  let recordIds = [];
  if (Array.isArray(item.recordIds)) {
    recordIds = item.recordIds.map(id => String(id)).filter(Boolean);
  } else if (Array.isArray(item.records)) {
    recordIds = item.records
      .map(entry => (entry && (entry.recordId || entry.id)) || entry)
      .filter(Boolean)
      .map(id => String(id));
  } else if (item.recordId || item.id) {
    recordIds = [String(item.recordId || item.id)];
  }

  return { description, recordIds };
}

function normalizeAssociationPatternItem(item) {
  if (typeof item === 'string' && item.trim()) {
    const text = sanitizeSecondPerson(item.trim());
    if (!text || /未发现明显的联想模式/.test(text)) return null;
    return text;
  }
  if (!item || typeof item !== 'object') return null;

  const text = sanitizeSecondPerson(
    item.description || item.summary || item.text || item.pattern || item.content || ''
  );
  if (!text || /未发现明显的联想模式/.test(text)) return null;
  return text;
}

function parseAnalysisJson(content) {
  if (!content || typeof content !== 'string') return null;
  let text = content.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    const keywords = Array.isArray(parsed.keywords)
      ? parsed.keywords
        .filter(item => typeof item === 'string' && item.trim())
        .map(item => sanitizeSecondPerson(item))
      : [];
    const patterns = Array.isArray(parsed.patterns)
      ? parsed.patterns.map(normalizePatternItem).filter(Boolean)
      : [];
    const relationshipSummary = typeof parsed.relationshipSummary === 'string'
      ? sanitizeSecondPerson(parsed.relationshipSummary)
      : '';
    const eventEmotionMap = {};
    if (Array.isArray(parsed.eventEmotions)) {
      parsed.eventEmotions.forEach(item => {
        if (!item || typeof item !== 'object') return;
        const recordId = item.recordId || item.id;
        const emotionWord = item.emotionWord || item.emotion || item.word;
        if (recordId && emotionWord && String(emotionWord).trim()) {
          eventEmotionMap[String(recordId)] = sanitizeSecondPerson(emotionWord);
        }
      });
    }
    const turningPoints = Array.isArray(parsed.turningPoints)
      ? parsed.turningPoints.map(normalizeTurningPointItem).filter(Boolean)
      : [];
    const associationPatterns = Array.isArray(parsed.associationPatterns)
      ? parsed.associationPatterns.map(normalizeAssociationPatternItem).filter(Boolean)
      : [];
    return {
      keywords: keywords.slice(0, 8),
      patterns,
      relationshipSummary,
      eventEmotionMap,
      turningPoints,
      associationPatterns,
    };
  } catch {
    return null;
  }
}

async function callDeepSeek(userContent) {
  if (!API_KEY) {
    throw new Error('DEEPSEEK_API_KEY 未配置');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        temperature: 0.3,
        max_tokens: 2500,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    const data = await response.json();
    if (!response.ok) {
      const message = data?.error?.message || response.statusText || 'DeepSeek API 请求失败';
      throw new Error(message);
    }

    const content = data?.choices?.[0]?.message?.content;
    const result = parseAnalysisJson(content);
    if (!result) {
      throw new Error('无法解析 DeepSeek 返回的 JSON 结果');
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function handleAnalyze(req, res) {
  try {
    const raw = await readRequestBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const userContent = body.userContent;
    if (!userContent || typeof userContent !== 'string' || !userContent.trim()) {
      sendJson(res, 400, { error: '缺少有效的 userContent' });
      return;
    }
    const result = await callDeepSeek(userContent.trim());
    sendJson(res, 200, { result });
  } catch (err) {
    const message = err.name === 'AbortError'
      ? 'DeepSeek API 请求超时（15秒）'
      : (err.message || '分析请求失败');
    sendJson(res, 502, { error: message });
  }
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(ROOT_DIR, safePath === '/' ? 'index.html' : safePath);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  if (!filePath.startsWith(ROOT_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (req.url === '/api/analyze' && req.method === 'POST') {
    await handleAnalyze(req, res);
    return;
  }

  if (req.method === 'GET') {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Method Not Allowed');
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`事实锚点记录器已启动: http://localhost:${PORT}`);
    if (!API_KEY) {
      console.warn('警告: 未检测到 DEEPSEEK_API_KEY，AI 分析将不可用，将回退到本地规则。');
    }
  });
}

module.exports = {
  SYSTEM_PROMPT,
  parseAnalysisJson,
  normalizePatternItem,
  normalizeTurningPointItem,
  normalizeAssociationPatternItem,
  resolvePatternTitle,
  callDeepSeek,
  sanitizeSecondPerson,
  isGenericPatternTitle,
};
