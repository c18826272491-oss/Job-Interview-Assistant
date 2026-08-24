const $ = (id) => document.getElementById(id);

const jobInput = $('job-description');
const interviewResults = $('interview-results');
const interviewContent = $('interview-content');
const greetingResults = $('greeting-results');
const greetingContent = $('greeting-content');
const optimizeResults = $('optimize-results');
const optimizeContent = $('optimize-content');

let resumeText = '';
let interviewPlainText = '';
let greetingPlainText = '';
let optimizePlainText = '';
let topTimer = null;
let resumeTimer = null;
let activeRequests = {};
let activeResumeModes = new Set();
let resumeModelName = '';

const interviewLines = [
  '正在拆解岗位要求，提炼核心考察点…',
  '匹配你的经历和岗位技能要求…',
  '分析面试官可能追问的方向…',
  '生成针对性的面试策略和建议…'
];

const resumeLines = [
  '正在分析岗位与简历的匹配度…',
  '优化技能描述和项目经历表达…',
  '提取岗位关键词提升匹配度…',
  '马上就好，正在生成最终版本…'
];

// ── 生成进度 ──────────────────────────────────

function updateResumeLabel() {
  const el = $('resume-generation-model');
  if (!el) return;
  const modes = [...activeResumeModes];
  if (modes.length === 0) return;
  const suffix = resumeModelName ? `（${resumeModelName}）` : '';
  if (modes.length === 2) {
    el.textContent = `正在生成打招呼语和优化简历${suffix}`;
  } else if (modes[0] === 'greeting') {
    el.textContent = `正在生成打招呼语${suffix}`;
  } else {
    el.textContent = `正在生成优化简历${suffix}`;
  }
}

function rotateMsg(el, lines) {
  let i = 0;
  el.textContent = lines[0];
  return setInterval(() => {
    i = (i + 1) % lines.length;
    el.textContent = lines[i];
  }, 5000);
}

function startGenerationProgress(modelName, zone, mode) {
  const isTop = zone === 'top';
  const box = $(isTop ? 'generating-status' : 'resume-generating-status');
  const modelEl = $(isTop ? 'generation-model' : 'resume-generation-model');
  const msgEl = $(isTop ? 'generation-message' : 'resume-generation-message');
  const lines = isTop ? interviewLines : resumeLines;

  if (isTop) {
    $('cancel-button').hidden = false;
    modelEl.textContent = `正在使用：${modelName}`;
    clearInterval(topTimer);
    topTimer = rotateMsg(msgEl, lines);
  } else {
    resumeModelName = modelName;
    activeResumeModes.add(mode);
    updateResumeLabel();
    $('resume-cancel-button').hidden = false;
    clearInterval(resumeTimer);
    resumeTimer = rotateMsg(msgEl, lines);
  }
  box.hidden = false;
}

function stopGenerationProgress(mode) {
  if (mode && mode !== 'interview') {
    activeResumeModes.delete(mode);
    if (activeResumeModes.size > 0) {
      updateResumeLabel();
      return;
    }
    clearInterval(resumeTimer);
    resumeTimer = null;
    $('resume-generating-status').hidden = true;
    $('resume-cancel-button').hidden = true;
    resumeModelName = '';
    return;
  }
  clearInterval(topTimer);
  clearInterval(resumeTimer);
  topTimer = null;
  resumeTimer = null;
  $('generating-status').hidden = true;
  $('resume-generating-status').hidden = true;
  $('cancel-button').hidden = true;
  $('resume-cancel-button').hidden = true;
  activeResumeModes.clear();
  resumeModelName = '';
}

// ── 简历区取消生成 ────────────────────────────

function cancelResumeGeneration() {
  Object.keys(activeRequests).forEach(k => {
    if (k !== 'interview') activeRequests[k].abort();
  });
  ['greeting', 'optimize'].forEach(k => delete activeRequests[k]);
  clearInterval(resumeTimer);
  resumeTimer = null;
  $('resume-generating-status').hidden = true;
  $('resume-cancel-button').hidden = true;
  activeResumeModes.clear();
  resumeModelName = '';
  $('resume-status').textContent = '已取消本次生成。';
}

// ── 复制保护 ──────────────────────────────────

function updateCopyState(active) {
  $('copy-state').textContent = active
    ? '网页复制保护已开启，仅在侧边栏打开期间生效'
    : '当前页面不支持解除复制限制';
}

function setCopyGuard(enabled) {
  chrome.runtime.sendMessage(
    { type: enabled ? 'copyGuard:enable' : 'copyGuard:disable' },
    (reply) => {
      if (chrome.runtime.lastError) { updateCopyState(false); return; }
      updateCopyState(Boolean(reply?.enabled));
    }
  );
}

const sidePanelPort = chrome.runtime.connect({ name: 'sidePanel' }); // 维持长连接，关闭侧边栏时 port.onDisconnect 触发后台清理复制保护
setCopyGuard(true);

// ── 记忆恢复 ──────────────────────────────────

function saveMemory() {
  chrome.storage.session.set({
    savedJob: jobInput.value,
    savedResumeText: resumeText,
    savedResumeFileName: $('file-label').textContent !== '上传简历' ? $('file-label').textContent : ''
  });
}

function saveResults(mode, sections) {
  chrome.storage.session.get(['savedResults'], (data) => {
    const results = data.savedResults || {};
    results[mode] = sections;
    chrome.storage.session.set({ savedResults: results });
  });
}

function loadMemory() {
  chrome.storage.session.get(['savedJob', 'savedResumeText', 'savedResumeFileName', 'generationInProgress', 'savedResults'], (data) => {
    if (data.savedJob) {
      jobInput.value = data.savedJob;
      updateJobControls();
    }
    if (data.savedResumeText) {
      resumeText = data.savedResumeText;
      if (data.savedResumeFileName) {
        $('file-label').textContent = data.savedResumeFileName;
        $('file-note').textContent = `已加载 ${resumeText.length} 个字符（上次上传）`;
      }
    }
    if (data.generationInProgress) {
      $('status-message').textContent = '上次生成被中断（关闭侧边栏会导致生成中断），内容已恢复，请重新生成。';
      chrome.storage.session.remove('generationInProgress');
    }
    if (data.savedResults) {
      if (data.savedResults.interview) renderSections(data.savedResults.interview, 'interview');
      if (data.savedResults.greeting) renderSections(data.savedResults.greeting, 'greeting');
      if (data.savedResults.optimize) renderSections(data.savedResults.optimize, 'optimize');
    }
  });
}

loadMemory();

// ── 岗位描述 ──────────────────────────────────

function updateJobControls() {
  $('word-count').textContent = `${jobInput.value.length} / 12000`;
  $('clear-job').hidden = !jobInput.value.length;
}

jobInput.addEventListener('input', () => { updateJobControls(); saveMemory(); });

$('clear-job').addEventListener('click', () => {
  jobInput.value = '';
  updateJobControls();
  jobInput.focus();
  saveMemory();
});

function cancelGeneration() {
  if (activeRequests['interview']) activeRequests['interview'].abort();
  delete activeRequests['interview'];
  clearInterval(topTimer);
  topTimer = null;
  $('generating-status').hidden = true;
  $('cancel-button').hidden = true;
  interviewContent.innerHTML = '';
  interviewResults.hidden = true;
  interviewPlainText = '';
  if (!greetingPlainText && !optimizePlainText) {
    $('empty-state').hidden = false;
  }
  $('status-message').textContent = '已取消本次生成。';
}

$('cancel-button').addEventListener('click', cancelGeneration);
$('resume-cancel-button').addEventListener('click', cancelResumeGeneration);

updateJobControls();

// ── 简历文件 ──────────────────────────────────

try { pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js'; } catch (e) { console.warn('PDF.js 未加载'); }

async function extractPdfText(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument(buf).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map(item => item.str).join(' '));
  }
  return pages.join('\n');
}

$('resume-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  $('file-label').textContent = file.name;
  $('file-note').textContent = '正在读取文件…';

  // 根据文件类型切换图标
  const icon = $('upload-icon');
  const ext = file.name.split('.').pop().toLowerCase();
  icon.className = 'upload-icon';
  if (ext === 'pdf') {
    icon.classList.add('type-pdf');
    icon.textContent = 'P';
  } else if (ext === 'doc' || ext === 'docx') {
    icon.classList.add('type-word');
    icon.textContent = 'W';
  } else if (ext === 'md') {
    icon.classList.add('type-md');
    icon.textContent = 'M';
  } else if (ext === 'txt') {
    icon.classList.add('type-txt');
    icon.textContent = 'T';
  }

  try {
    if (/\.(txt|md)$/i.test(file.name)) {
      resumeText = await file.text();
    } else if (/\.pdf$/i.test(file.name)) {
      resumeText = await extractPdfText(file);
    } else if (/\.docx$/i.test(file.name)) {
      const buf = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer: buf });
      resumeText = result.value;
    } else {
      resumeText = `[用户上传了 ${file.name}，请将其作为简历附件参考。]`;
      $('file-note').textContent = '已附加文件。为获得更精准匹配，建议上传 TXT、MD、PDF 或 DOCX 格式的简历。';
      return;
    }
    if (!resumeText.trim()) {
      $('file-note').textContent = '未能提取到文字内容，请确认文件包含可读文本。';
      return;
    }
    $('file-note').textContent = `已读取 ${resumeText.length} 个字符，将用于匹配你的真实经历。`;
    saveMemory();
  } catch (e) {
    resumeText = `[用户上传了 ${file.name}，但无法解析内容：${e.message}]`;
    $('file-note').textContent = '文件解析失败，请尝试粘贴简历文本或上传 TXT 格式。';
  }
});

$('clear-resume').addEventListener('click', (e) => {
  e.preventDefault();
  $('resume-file').value = '';
  resumeText = '';
  $('file-label').textContent = '上传简历';
  $('file-note').textContent = '';
  const icon = $('upload-icon');
  icon.className = 'upload-icon';
  icon.textContent = '↑';
  saveMemory();
});

// ── 结果渲染 ──────────────────────────────────

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[c]));
}

function formatBody(text) {
  if (text == null || text === '') return '';
  let result = escapeHtml(String(text));
  // 去掉残留的 markdown 分隔线和标题标记
  result = result.replace(/^---+\s*$/gm, '');
  result = result.replace(/^#{1,4}\s*/gm, '');
  // **加粗** → <strong>
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // __加粗__ → <strong>
  result = result.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  // *斜体* → <em>
  result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return result;
}

function renderSections(sections, target) {
  const plainText = sections
    .map(s => {
      const body = Array.isArray(s.body)
        ? s.body.map(i => typeof i === 'object' ? JSON.stringify(i) : i).join('\n')
        : s.body;
      return `${s.title}\n${body}`;
    })
    .join('\n\n');

  const html = sections.map(s => {
    const isDivider = s.title && s.title.startsWith('第二部分');
    const bodyText = Array.isArray(s.body) ? s.body.join(' ') : (s.body || '');
    const isParagraph = target !== 'greeting' && !s.list && bodyText.length < 200 && !isDivider;

    const cls = isDivider ? 'result-section divider'
      : isParagraph ? 'result-section paragraph'
      : s.suggestion ? 'result-section suggestion'
      : 'result-section';

    const rawItems = s.list
      ? (Array.isArray(s.body) ? s.body : String(s.body).split('\n').filter(Boolean))
      : [s.body];
    const body = s.list
      ? `<ul>${rawItems.map(i => `<li>${formatBody(typeof i === 'object' ? JSON.stringify(i) : i)}</li>`).join('')}</ul>`
      : `<p>${formatBody(typeof rawItems[0] === 'object' ? JSON.stringify(rawItems[0]) : rawItems[0])}</p>`;
    const copyBtn = (isDivider || isParagraph) ? '' : `<button class="copy-section" title="复制此板块"><img src="assets/copy.png" alt="复制"></button>`;
    return `<article class="${cls}"><h3>${escapeHtml(s.title)}${copyBtn}</h3>${body}</article>`;
  }).join('');

  if (target === 'interview') {
    interviewPlainText = plainText;
    interviewContent.innerHTML = html;
    interviewResults.hidden = false;
    document.querySelector('.copy-interview').hidden = false;
  } else if (target === 'greeting') {
    greetingPlainText = plainText;
    greetingContent.innerHTML = html;
    greetingResults.hidden = false;
    document.querySelector('.copy-greeting').hidden = false;
  } else if (target === 'optimize') {
    optimizePlainText = plainText;
    optimizeContent.innerHTML = html;
    optimizeResults.hidden = false;
    document.querySelector('.copy-optimize').hidden = false;
  }
  $('empty-state').hidden = true;
}

// ── 本地演示逻辑 ──────────────────────────────

function fallback(type, job) {
  const focus = job.includes('产品')
    ? '用户需求、版本推进和跨团队协作'
    : job.includes('数据')
      ? '指标口径、数据分析和业务判断'
      : job.includes('运营')
        ? '用户增长、内容策略和复盘能力'
        : '岗位核心职责、协作方式和交付结果';

  if (type === 'optimize') return [
    { title: '综合匹配评分', body: '演示数据无法给出真实评分。连接AI服务后，将根据您的简历与岗位进行精确匹配分析。', list: false, suggestion: false },
    { title: '岗位核心要求拆解', list: true, body: [`岗位方向：${focus}`, '重要程度：根据JD中出现的频率和位置判断', '匹配说明：需连接AI服务进行简历内容分析'], suggestion: false },
    { title: '当前不足分析', list: true, body: ['演示模式无法读取简历细节', '请连接AI服务获取针对性优化建议', '上传简历并填写岗位职责后点击"优化简历"'], suggestion: true },
    { title: '求职建议', body: '目前是演示内容。到"设置"连接AI服务后，可生成包含匹配评分、技能拆解、项目优化、关键词分析、完整优化简历和求职建议的详细报告。', list: false, suggestion: true }
  ];

  if (type === 'greeting') return [
    { title: '正式专业版', body: `您好，我目前主要关注${focus}方向。了解到贵公司正在招聘相关岗位，与我过往的学习和项目经历比较匹配，希望能有机会进一步沟通，谢谢。`, list: false, suggestion: false },
    { title: '自然沟通版', body: `您好，我看到贵司正在招聘的岗位和我的经历比较匹配。之前我主要接触过${focus}相关内容，希望有机会和您进一步交流。`, list: false, suggestion: false },
    { title: '突出优势版', body: `您好，我的主要方向是${focus}。看到贵司岗位后，发现岗位重点与我的项目经验比较契合，希望能够进一步了解岗位需求，也期待有机会加入团队。`, list: false, suggestion: false },
    { title: '推荐分析', body: ['推荐：自然沟通版，适合大多数求职场景', '匹配点：岗位方向与用户经历基本吻合', '注意：演示内容仅供体验，连接API后可获得真实分析'], list: true, suggestion: true }
  ];

  return [
    { title: '岗位深度拆解', body: `这个岗位的核心是做${focus}相关的工作。JD里反复提到要能独立推进业务，说明团队希望找一个来了就能上手的人，不是来学习的。你需要重点准备：你对这个方向的理解到底有多深，以及你有什么案例能证明你做过。面试前把这公司产品用一遍，找个具体问题准备你的看法，面试时主动说出来。`, list: false, suggestion: false },
    { title: '核心技能逐个分析', list: true, body: [`${focus} — ★★★ 必问 — JD提了好几次，这是核心中的核心。别光说会，准备一个你主导的具体案例，讲清楚你做了什么、怎么做的、结果怎样`, '推进能力 — ★★ 高频 — 面试官想看到你不是只会执行，而是能把一件事从开始推到结束。准备一个遇到困难但没放弃的例子', '沟通协作 — ★★ 高频 — 这个岗位大概率要跟多个部门打交道。准备一个你跟别人意见不合但最终达成一致的例子', '数据意识 — ★ 加分 — 这个做好了能拉开差距。你准备的项目案例里，能用数字的地方都用数字说话'], suggestion: false },
    { title: '竞争力评估', body: '光看JD的话，这个岗位竞争不会小。你的优势在于能把事情讲清楚、有案例可讲。建议重点打磨3个最能打的案例，面试时翻来覆去就用这三个打。', list: false, suggestion: false },
    { title: '高频面试问题', list: true, body: ['"讲一个你最有挑战的项目" → 别流水账从头讲到尾，直接说遇到了什么困难、你做了什么决策、最后怎么样了', '"你对这个岗位的理解" → 别复述JD，用你自己的话讲这个岗位到底要解决什么问题', '"为什么离开上一家" → 一句话带过就行，重点说为什么选这家、你来了能干什么', '"你怎么看我们产品" → 面试前必须用，说不出一两条建议就太被动了', '"你有什么想问我们的" → 问"团队目前最大的挑战是什么""这岗位做到什么程度算优秀"'], suggestion: false },
    { title: '面试现场技巧', list: true, body: ['进门先微笑打招呼，坐下了别急着说话，等面试官先开口', '被问到不会的：别说"不知道"，说"这块我之前接触不多，我的理解是XXX，您看对不对"', '面试官追问细节说明他对你感兴趣，这是好事，多展开讲讲', '面完当天或第二天发个消息，简单说句感谢，提一下面试里聊过的具体话题', '工资等对方先开口。问到了就说"想先了解一下这个岗位的薪资结构和预算范围"'], suggestion: false }
  ];
}

// ── API 调用 ──────────────────────────────────

async function getSettings() {
  return new Promise(resolve => chrome.storage.local.get(['apiUrl', 'apiKey', 'model'], resolve));
}

function getCompletionUrl(input) {
  const base = input.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  if (/api\.openai\.com$/i.test(base)) return `${base}/v1/chat/completions`;
  return `${base}/chat/completions`;
}

async function generate(mode) {
  if (!promptsReady) { await promptsLoaded; }
  const job = jobInput.value.trim();

  // ── 校验：面试模式 ────────────────────────────

  if (mode === 'interview' && job.length < 20) {
    $('status-message').textContent = '请先粘贴至少 20 个字的岗位职责或任职要求。';
    jobInput.focus();
    return;
  }

  // ── 校验：打招呼语 / 优化简历 ────────────────

  if ((mode === 'greeting' || mode === 'optimize') && (job.length < 20 || !resumeText)) {
    const missing = [];
    if (job.length < 20) missing.push('岗位职责');
    if (!resumeText) missing.push('简历文件');
    $('resume-status').textContent = `请先填写：${missing.join('、')}。`;
    return;
  }

  if (mode === 'interview') $('status-message').textContent = '正在整理岗位信息…';
  if (mode !== 'interview') $('resume-status').textContent = '正在生成…';
  $('empty-state').hidden = true;
  chrome.storage.session.set({ generationInProgress: true });

  if (mode === 'interview') {
    interviewContent.innerHTML = $('loading-template').innerHTML + $('loading-template').innerHTML;
    interviewResults.hidden = false;
  } else if (mode === 'greeting') {
    greetingContent.innerHTML = $('loading-template').innerHTML;
    greetingResults.hidden = false;
    document.querySelector('.copy-greeting').hidden = true;
  } else if (mode === 'optimize') {
    optimizeContent.innerHTML = $('loading-template').innerHTML;
    optimizeResults.hidden = false;
    document.querySelector('.copy-optimize').hidden = true;
  }

  const settings = await getSettings();
  const modelName = settings.apiUrl ? (settings.model || 'gpt-4.1-mini') : '本地演示逻辑';
  const progressZone = mode === 'interview' ? 'top' : 'resume';
  startGenerationProgress(modelName, progressZone, mode);

  if (!settings.apiUrl || !settings.apiKey) {
    if (mode === 'interview') {
      renderSections(fallback('interview', job), 'interview');
      $('status-message').textContent = '目前是演示内容。到"设置"连接 AI 服务后即可生成真实结果。';
    } else if (mode === 'greeting') {
      renderSections(fallback('greeting', job), 'greeting');
      $('resume-status').textContent = '目前是演示内容。到"设置"连接 AI 服务后即可生成真实结果。';
    } else if (mode === 'optimize') {
      renderSections(fallback('optimize', job), 'optimize');
      $('resume-status').textContent = '目前是演示内容。到"设置"连接 AI 服务后即可生成真实结果。';
    }
    stopGenerationProgress(mode);
    return;
  }

  // ── 构建 Prompt 列表（面试模式分两步）──────────

  let promptList = [];
  if (mode === 'interview') {
    let step1 = `${JD_ANALYSIS_PROMPT}\n\n用户输入岗位JD：\n${job}`;
    if (resumeText) {
      step1 += `\n\n用户已上传简历，请在标题中结合简历给出匹配度（例如"匹配度约70%"）。简历内容仅用于评估匹配度，不要写入输出正文。\n用户简历：\n${resumeText}`;
    } else {
      step1 += `\n\n用户未上传简历，标题不要输出匹配度或匹配分，只基于 JD 本身分析。`;
    }
    promptList = [
      { text: step1, tokens: 2500 },
      { text: `${INTERVIEW_PREP_PROMPT}\n\n用户输入岗位JD：\n${job}`, tokens: 4000 }
    ];
  } else if (mode === 'greeting') {
    promptList = [{ text: `${GREETING_PROMPT}\n\n【目标岗位名称】\n${job.slice(0, 60)}\n\n【岗位职责JD】\n${job}\n\n【用户简历】\n${resumeText}`, tokens: 800 }];
  } else if (mode === 'optimize') {
    promptList = [{ text: `${RESUME_OPTIMIZE_PROMPT}\n\n【目标岗位名称】\n${job.slice(0, 60)}\n\n【岗位职责JD】\n${job}\n\n【用户当前简历】\n${resumeText}`, tokens: 5000 }];
  }

  // ── API 请求 ──────────────────────────────────

  async function callApi(promptText, maxTokens) {
    const completionUrl = getCompletionUrl(settings.apiUrl);
    const controller = new AbortController();
    activeRequests[mode] = controller;
    const body = { model: settings.model || 'gpt-4.1-mini', messages: [{ role: 'user', content: promptText }] };
    if (maxTokens) body.max_tokens = maxTokens;
    if (/deepseek/i.test(body.model)) body.thinking = { type: 'disabled' };

    const response = await fetch(completionUrl, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`服务返回 ${response.status}${response.status === 404 ? `：请检查接口地址。实际请求的是 ${completionUrl}` : detail ? `：${detail.slice(0, 180)}` : ''}`);
    }

    const data = await response.json();
    const first = data.choices?.[0];
    const content = first?.message?.content;
    if (!content) {
      const reasoning = first?.message?.reasoning_content;
      console.error('API返回空内容', {
        model: settings.model,
        promptLen: promptText.length,
        reasoningPresent: !!reasoning,
        finish_reason: first?.finish_reason,
        choices: data.choices?.length
      });
      if (reasoning) {
        throw new Error(`AI返回内容为空：${settings.model} 开启了思考模式，输出配额全被思考过程占用。请在模型文档中关闭思考模式，或更换为非思考模型。`);
      }
      throw new Error('AI返回内容为空，请检查模型名称是否正确，或尝试更换模型');
    }
    return content;
  }

  function parseSections(raw) {
    const text = raw.replace(/```[\s\S]*?```/g, '').trim();
    if (!text) throw new Error('AI返回为空，请重试');

    // 按 ## 标题分块（兼容有无换行前缀）
    const blocks = text.split(/\n(?=## )|(?<=.)(?=## )/);
    if (blocks.length === 1 && !text.startsWith('#')) {
      // 整个文本没有 ## 标题，作为单个板块
      const lines = text.split('\n').filter(Boolean);
      return [{ title: lines[0] || '分析结果', body: lines.slice(1).join('\n'), list: false, suggestion: false }];
    }

    const sections = [];
    for (const block of blocks) {
      const lines = block.trim().split('\n');
      const title = lines[0].replace(/^#{1,4}\s*/, '').trim();
      if (!title) continue;

      const bodyLines = lines.slice(1)
        .map(l => l.trim().replace(/^#{1,4}\s*/, ''))
        .filter(Boolean);
      const isList = bodyLines.length > 0 && bodyLines[0].startsWith('- ');

      sections.push({
        title: title,
        body: isList
          ? bodyLines.map(l => l.replace(/^-\s*/, ''))
          : bodyLines.join('\n'),
        list: isList,
        suggestion: ['建议补充', '推荐分析', '注意事项', '当前不足'].some(k => title.includes(k))
      });
    }

    if (sections.length === 0) throw new Error('未找到有效板块');
    return sections;
  }

  try {
    const allSections = [];
    for (const step of promptList) {
      const raw = await callApi(step.text, step.tokens);
      const sections = parseSections(raw);
      allSections.push(...sections);
    }

    delete activeRequests[mode];
    chrome.storage.session.remove('generationInProgress');
    saveResults(mode, allSections);
    if (mode === 'interview') {
      renderSections(allSections, 'interview');
      $('status-message').textContent = '已生成。建议逐条核对真实经历再使用。';
    } else if (mode === 'greeting') {
      renderSections(allSections, 'greeting');
      $('resume-status').textContent = '已生成。';
    } else if (mode === 'optimize') {
      renderSections(allSections, 'optimize');
      $('resume-status').textContent = '已生成。建议逐条核对真实经历再使用。';
    }
    stopGenerationProgress(mode);
  } catch (error) {
    delete activeRequests[mode];
    chrome.storage.session.remove('generationInProgress');
    if (error.name === 'AbortError') return;

    const errorInfo = [{ title: '生成失败', body: `调用AI服务时出错：${error.message}。请检查接口地址、API Key 和模型名称是否正确，或者稍后重试。`, list: false, suggestion: false }];

    if (mode === 'interview') {
      renderSections(errorInfo, 'interview');
      $('status-message').textContent = '生成失败，请检查设置后重试。';
    } else if (mode === 'greeting') {
      renderSections(errorInfo, 'greeting');
      $('resume-status').textContent = '生成失败，请检查设置后重试。';
    } else if (mode === 'optimize') {
      renderSections(errorInfo, 'optimize');
      $('resume-status').textContent = '生成失败，请检查设置后重试。';
    }
    stopGenerationProgress(mode);
  }
}

// ── 结果折叠/展开 & 单板块复制 ─────────────────

document.addEventListener('click', async (e) => {
  // 单板块复制
  const copyBtn = e.target.closest('.copy-section');
  if (copyBtn) {
    e.stopPropagation();
    const section = copyBtn.closest('.result-section');
    const title = section.querySelector('h3').textContent;
    const body = section.querySelector('p, ul');
    const text = body ? `${title}\n${body.textContent}` : title;
    await navigator.clipboard.writeText(text);
    copyBtn.classList.add('copied');
    setTimeout(() => copyBtn.classList.remove('copied'), 1200);
    return;
  }
  // 折叠/展开
  const section = e.target.closest('.result-section');
  if (!section) return;
  if (e.target.closest('.result-section h3')) {
    section.classList.toggle('collapsed');
  }
});

// ── 事件绑定 ──────────────────────────────────

$('analyze-button').addEventListener('click', () => generate('interview'));
$('greeting-button').addEventListener('click', () => generate('greeting'));
$('resume-button').addEventListener('click', () => generate('optimize'));

document.querySelector('.copy-interview').addEventListener('click', async () => {
  await navigator.clipboard.writeText(interviewPlainText);
  const btn = document.querySelector('.copy-interview');
  btn.textContent = '已复制';
  setTimeout(() => btn.textContent = '复制全部', 1500);
});

document.querySelector('.copy-greeting').addEventListener('click', async () => {
  await navigator.clipboard.writeText(greetingPlainText);
  const btn = document.querySelector('.copy-greeting');
  btn.textContent = '已复制';
  setTimeout(() => btn.textContent = '复制全部', 1500);
});

document.querySelector('.copy-optimize').addEventListener('click', async () => {
  await navigator.clipboard.writeText(optimizePlainText);
  const btn = document.querySelector('.copy-optimize');
  btn.textContent = '已复制';
  setTimeout(() => btn.textContent = '复制全部', 1500);
});
