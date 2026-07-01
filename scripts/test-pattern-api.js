require('dotenv').config();

const { callDeepSeek, resolvePatternTitle } = require('../server.js');

const SAMPLE_USER_CONTENT = `以下是用户关于当前分析对象的事件记录，请从中提取关键词、互动模式、关系变化趋势，以及每条事件的情绪词。
分析对象：L
记录条数：3
关系背景：你们是高中的同学，现在是朋友，近半年经常聊天。

【事件 1】
记录ID：evt-001
对象：L
事件发生时间：2026年1月5日
事件标题：聚会迟到
事件背景：约好周末一起吃饭
事件的开始：我到了餐厅等了一小时
对方具体做了什么/说了什么：L迟到一小时，只说「路上堵车」，没有道歉
我从哪一刻开始感受到了情绪：等40分钟时
我当时心里具体怎么想的：我觉得很不被尊重，有点生气
我面对这个情况做了什么？对方有什么反应？：我发消息问还要多久，L回复「别催」
结束方式：我沉默，饭局气氛很僵
联想到过去的事情或脑海中的画面：（未填写）

---

【事件 2】
记录ID：evt-002
对象：L
事件发生时间：2026年2月10日
事件标题：消息已读不回
事件背景：我分享工作上的困扰
事件的开始：我发了几条长消息
对方具体做了什么/说了什么：L已读不回，隔天才回「刚看到，最近忙」
我从哪一刻开始感受到了情绪：看到已读不回时
我当时心里具体怎么想的：我表达不满，觉得被忽略
我面对这个情况做了什么？对方有什么反应？：我说「你至少回一句」，L说「你想太多」
结束方式：对话中断
联想到过去的事情或脑海中的画面：想起上次聚会

---

【事件 3】
记录ID：evt-003
对象：L
事件发生时间：2026年3月1日
事件标题：比较我
事件背景：聊到共同朋友
事件的开始：我说最近有点累
对方具体做了什么/说了什么：L说「你看人家小敏多能干，你怎么老抱怨」
我从哪一刻开始感受到了情绪：听到比较时
我当时心里具体怎么想的：很委屈，觉得被否定
我面对这个情况做了什么？对方有什么反应？：我反驳，L说「开个玩笑而已」
结束方式：我结束话题，不再回复
联想到过去的事情或脑海中的画面：（未填写）`;

function assertTitle(rawTitle, rawDescription, expected) {
  const got = resolvePatternTitle(rawTitle, rawDescription);
  const ok = got === expected;
  console.log(ok ? 'OK' : 'FAIL', { rawTitle, got, expected });
  return ok;
}

async function main() {
  console.log('=== 本地标题兜底测试 ===');
  let ok = true;
  ok = assertTitle('无效的争吵：表达不满→被反击→沉默收场', '详细描述', '无效的争吵：表达不满→被反击→沉默收场') && ok;
  ok = assertTitle('', '在你记录的3次事件中，有2次出现了这样的结构：你表达不满→对方反击→最终以沉默结束。', '在你记录的3次事件中，有2次出现了这样的结构：你表达不满→对') && ok;
  ok = assertTitle('', '', '') && ok;
  if (!ok) process.exit(1);

  console.log('\n正在调用 DeepSeek API 测试模式标题...\n');
  const result = await callDeepSeek(SAMPLE_USER_CONTENT);

  console.log('=== patterns ===');
  result.patterns.forEach((p, i) => {
    console.log(`[${i + 1}] title: ${p.title}`);
    console.log(`    description: ${p.description}`);
  });

  const allText = JSON.stringify(result);
  const hasUserWord = allText.includes('用户');
  console.log('\n=== 验证 ===');
  console.log('1. 每个模式均有标题:', result.patterns.every(p => p.title && p.title.trim()));
  console.log('2. 描述有信息增量:', result.patterns.every(p => p.description && p.description.length > p.title.length));
  console.log('3. 全文无「用户」:', !hasUserWord);
  console.log('\n完整 JSON:\n', JSON.stringify(result, null, 2));

  if (hasUserWord || !result.patterns.every(p => p.title && p.title.trim())) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
