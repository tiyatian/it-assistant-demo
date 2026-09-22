// Local Apple Vision OCR + conservative routing, not a remote multimodal model.
let pendingScreenshot = null;
let screenshotSelection = 0;
const imagePayloads = new Map();
const imageLabels = { vpn: 'VPN 连接异常', network: '网络连接异常', permission: '访问权限异常', software: '软件运行或安装异常', security: '疑似账号或安全异常', unknown: '待确认的截图问题' };
const imageActions = '<div class="quick-actions"><button class="quick-action" data-action="handoff">转人工</button></div>';

function updateAttachmentUI() {
  for (const selector of ['#heroAttachment', '#chatAttachment']) {
    const node = $(selector);
    node.classList.toggle('hidden', !pendingScreenshot);
    node.innerHTML = pendingScreenshot ? `<img src="${pendingScreenshot.preview}" alt="待发送截图预览"/><div class="attachment-copy"><strong>${escapeHTML(pendingScreenshot.name)}</strong><small>发送后识别 · 请先遮挡密码等敏感信息</small></div><button class="icon-button" type="button" data-remove-screenshot aria-label="移除截图">×</button>` : '';
  }
  heroSend.disabled = !heroInput.value.trim() && !pendingScreenshot;
  chatSend.disabled = !chatInput.value.trim() && !pendingScreenshot;
}

function clearPendingScreenshot() {
  screenshotSelection++;
  pendingScreenshot = null;
  $('#screenshotInput').value = '';
  updateAttachmentUI();
  if (!state.screenshots.length) imagePayloads.clear();
}

async function selectScreenshot(file) {
  if (!file || actionLocked) return;
  if (state.ticket) return toast('此工单已提交，请新建会话上传新的问题截图');
  if (state.screenshots.length >= 4) return toast('每次会话最多保留 4 张截图，请补充文字或转人工');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return toast('请选择 PNG、JPEG 或 WebP 图片');
  if (file.size > 5 * 1024 * 1024) return toast('截图不能超过 5MB，请裁剪后重新选择');
  const selection = ++screenshotSelection;
  const objectURL = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = objectURL;
    await img.decode();
    if (!img.width || img.width * img.height > 24000000) throw new Error('图片尺寸过大，请裁剪到错误提示区域');
    const encode = (max, quality) => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', quality);
    };
    const image = encode(2400, .9);
    let preview = encode(1400, .75);
    if (preview.length > 220000) preview = encode(1000, .6);
    if (preview.length > 220000) preview = encode(700, .5);
    if (selection !== screenshotSelection) return;
    pendingScreenshot = { id: `IMG-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: file.name, preview, image };
    updateAttachmentUI();
  } catch (error) {
    toast(error.message.includes('尺寸') ? error.message : '无法读取图片，请重新选择有效的截图');
  } finally {
    URL.revokeObjectURL(objectURL);
    $('#screenshotInput').value = '';
  }
}

async function sendScreenshot(text, attachment) {
  if (actionLocked) return;
  if (state.ticket) return toast('此工单已提交，请新建会话上传截图');
  clearPendingScreenshot();
  if (state.phase === 'welcome') {
    state.title = text.trim().slice(0, 24) || '截图问题排查';
  }
  if (state.phase !== 'handoff') state.phase = 'active';
  state.resolved = false;
  state.issueDescription = [state.issueDescription, text.trim()].filter(Boolean).join('\n');
  $('#conversationStatus').textContent = '正在处理';
  const shot = { id: attachment.id, name: attachment.name, preview: attachment.preview, analysis: null };
  state.screenshots.push(shot);
  imagePayloads.set(shot.id, attachment.image);
  showChat();
  addMessage('user', text.trim() ? `<p>${escapeHTML(text.trim())}</p>` : '<p class="screenshot-caption">请帮我看看这个问题</p>', { screenshotId: shot.id });
  await analyzeScreenshot(shot, text);
}

async function analyzeScreenshot(shot, userText = '') {
  if (actionLocked || state.ticket) return;
  actionLocked = true;
  $$('[data-upload]').forEach(button => { button.disabled = true; });
  showTyping('正在读取截图中的文字和错误提示…');
  $('.bubble', typingNode).insertAdjacentHTML('beforeend', '<p class="image-analysis-label">正在识别截图中的错误提示…</p>');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);
  let analysis;
  try {
    const base = location.protocol === 'http:' && location.port === '4174' ? '' : 'http://localhost:4174';
    const response = await fetch(`${base}/api/analyze-image`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imagePayloads.get(shot.id) || shot.preview }), signal: controller.signal
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '截图识别失败，请重试');
    analysis = result;
    shot.analysis = result;
    shot.error = '';
  } catch (error) {
    const message = error.name === 'AbortError' ? '截图识别超时，请重试，或直接描述错误提示。' : error instanceof TypeError ? '本地截图识别服务未连接。请运行 python3 server.py，并打开 http://localhost:4174 后重试；也可以直接输入错误提示。' : error.message;
    shot.error = message;
    state.awaitingImageDescription = true;
    hideTyping();
    addMessage('assistant', `<p>${escapeHTML(message)}</p><p>截图已保留，我不会在未读取成功时猜测问题。</p><div class="quick-actions"><button class="quick-action" data-retry-screenshot="${escapeHTML(shot.id)}">重新识别</button><button class="quick-action" data-action="handoff">转人工</button></div>`);
  } finally {
    clearTimeout(timeout);
    hideTyping();
    actionLocked = false;
    $$('[data-upload]').forEach(button => { button.disabled = false; });
    saveState();
  }
  if (!analysis) return;
  const category = imageLabels[analysis.category] ? analysis.category : 'unknown';
  const codes = analysis.errorCodes || [];
  addMessage('assistant', `<p>${analysis.hasText ? `截图中检测到${category === 'unknown' ? '以下文字，暂时无法可靠判断故障类型' : `与「${imageLabels[category]}」有关的信息`}。` : '这张截图没有识别到清晰的错误文字。'}</p>${codes.length ? `<p><strong>错误提示：</strong>${escapeHTML(codes.join('、'))}</p>` : ''}${analysis.environment ? `<p><strong>截图环境：</strong>${escapeHTML(analysis.environment)}</p>` : ''}${analysis.hasText ? `<details class="image-analysis"><summary>查看识别文字（可在对话中纠正）</summary><pre>${escapeHTML(analysis.text)}</pre></details>` : ''}<p class="image-analysis-label">本机文字识别 + 规则判断 · 不是根因结论</p>`);
  if (userText && /转人工|创建工单|提单/.test(userText)) return startHandoff('user_request');
  if (state.phase === 'handoff') {
    state.ticketDraft = buildScreenshotTicketDraft();
    return assistantReply('<p>新截图已补充到工单上下文。请继续确认紧急程度及工单内容。</p>', 200, 'result');
  }
  const textCategory = userText ? detectScenario(userText) : 'generic';
  const effective = category === 'unknown' && ['vpn', 'network'].includes(textCategory) ? textCategory : category;
  if (!['vpn', 'network'].includes(effective)) {
    state.awaitingImageDescription = true;
    if (category !== 'unknown') {
      state.scenario = category;
      return assistantReply(`<p>目前的演示知识不足以可靠处理这类问题。请补充正在使用的应用、触发操作及影响；也可以直接转人工，截图和识别文字会一并保留。</p>${imageActions}`, 200, 'clarify');
    }
    return assistantReply(`<p>请补充：这是哪个应用，执行什么操作后出现的问题？也可以上传只包含错误提示的清晰截图。</p>${imageActions}`, 200, 'clarify');
  }
  if (state.scenario && state.scenario !== effective) state.attempt = 0;
  state.scenario = effective;
  state.awaitingImageDescription = false;
  if (!state.os && analysis.environment) state.os = analysis.environment;
  state.title = imageLabels[effective];
  $('#conversationTitle').textContent = state.title;
  updateFacts({ '问题': state.title, '截图': `${state.screenshots.length} 张`, '状态': '继续排查' });
  // Merely uploading a new image is not proof that an earlier step was executed.
  if (state.attempt) return assistantReply(`<p>已把新截图加入排查记录。上一方案执行后结果如何？如果有新的现象，请直接描述，我不会重复要求你执行已失败的步骤。</p><div class="quick-actions"><button class="quick-action success" data-action="solved">已解决</button><button class="quick-action" data-action="not-solved">仍未解决</button><button class="quick-action" data-action="handoff">转人工</button></div>`, 200, 'knowledge');
  await continueScreenshotTroubleshooting();
}

async function continueScreenshotTroubleshooting() {
  if (!state.os) {
    return assistantReply('<p>截图没有明确显示操作系统。为了给出适用的步骤，这台电脑使用什么系统？</p><div class="quick-actions"><button class="quick-action" data-action="choose-os" data-value="Windows">Windows</button><button class="quick-action" data-action="choose-os" data-value="macOS">macOS</button><button class="quick-action" data-action="handoff">转人工</button></div>', 200, 'clarify');
  }
  if (state.scenario === 'network') await showNetworkStep();
  else await showVpnStep();
}

async function showScreenshotStep(category) {
  state.attempt = 1;
  const vpn = category === 'vpn';
  const title = vpn ? '重新建立 VPN 会话' : '检查本机网络连接';
  state.troubleshooting.push({ step: title, result: '已提供步骤，待用户反馈' });
  const steps = vpn
    ? '<li>退出当前 VPN 客户端后重新打开。</li><li>使用原有的公司账号和节点重新连接，不修改服务器地址。</li><li>如果仍有报错，保留最新提示；不要在对话中发送密码。</li>'
    : '<li>确认 Wi-Fi 已连接，或有线网络的网线已插好。</li><li>查看设备是否显示无网络，并尝试打开其他常用网页。</li><li>记录是所有网页都打不开，还是仅公司系统异常。</li>';
  await assistantReply(`<p>根据截图与当前上下文，先进行以下基础检查。当前环境：<strong>${escapeHTML(state.os)}</strong>，如识别有误可直接纠正。</p><div class="knowledge-card"><div class="knowledge-head">${icons.info}<div><strong>${title}</strong><small>基础排查 · 不修改服务端配置</small></div></div><ol class="step-list">${steps}</ol><div class="knowledge-source"><span>演示知识 · ${vpn ? 'VPN' : '网络'}基础排查指南（非真实企业知识库）</span></div></div><div class="quick-actions"><button class="quick-action success" data-action="solved">已解决</button><button class="quick-action" data-action="not-solved">仍未解决</button><button class="quick-action" data-action="handoff">转人工</button></div>`, 350, 'knowledge');
  updateFacts({ '状态': '等待操作结果', '当前步骤': title, '截图': `${state.screenshots.length} 张` });
  saveState();
}

async function routeScreenshotText(text) {
  // Only explicit user messages drive actions; OCR text is never treated as instructions.
  if (/工单.*(进度|状态|怎么样)|处理到哪/.test(text)) { await showTicketStatus(); return true; }
  if (/转人工|提单|创建工单|提交工单/.test(text)) { await startHandoff(); return true; }
  if (state.ticket) { await assistantReply('<p>这条工单已经提交，新增内容暂不支持同步到 ITop。你可以查询当前进度，或新建会话处理另一个问题。</p>'); return true; }
  if (/^(已解决|已经解决了?|解决了|好了|恢复了)[！!。\s]*$/.test(text)) { await markResolved(true); return true; }
  if (state.resolved) { state.resolved = false; state.phase = 'active'; $('#conversationStatus').textContent = '正在处理'; }
  if (/未解决|不行|无效|没用|还是.*(失败|报错)|仍然.*(失败|报错)/.test(text) && state.attempt) { await handleUnresolved(true); return true; }
  const os = text.match(/Windows\s*(?:10|11)?|macOS(?:\s*\d+(?:\.\d+)*)?|苹果电脑/i);
  if (os) {
    state.os = /苹果/.test(os[0]) ? 'macOS' : os[0];
    if (['vpn', 'network'].includes(state.scenario) && !state.attempt) { await continueScreenshotTroubleshooting(); return true; }
  }
  state.issueDescription = [state.issueDescription, text].filter(Boolean).join('\n');
  const category = detectScenario(text);
  if (category === 'sensitive') return false;
  if (['vpn', 'network'].includes(category) && !state.attempt) {
    state.scenario = category;
    state.awaitingImageDescription = false;
    await continueScreenshotTroubleshooting();
    return true;
  }
  if (state.phase === 'handoff') {
    state.ticketDraft = buildScreenshotTicketDraft();
    await assistantReply('<p>补充信息已记录到工单，请继续选择紧急程度，并确认提交内容。</p>');
    return true;
  }
  await assistantReply(`<p>已记录补充信息。${state.attempt ? '请说明上一方案执行后的具体结果，或上传最新错误截图。' : '目前还没有足够可靠的信息给出操作步骤，请补充具体应用与错误提示，或转人工继续处理。'}</p>${imageActions}`, 250, 'clarify');
  return true;
}

function buildScreenshotTicketDraft() {
  const records = state.screenshots.map((shot, index) => `截图 ${index + 1}：${shot.analysis?.text || '未成功识别文字，需人工查看截图'}`).join('\n\n');
  return {
    title: state.title || imageLabels[state.scenario] || '截图问题待排查',
    summary: `${state.issueDescription || '用户通过截图报告 IT 问题。'}\n\n截图识别记录（需核对）：\n${records}`,
    environment: state.os || '用户尚未提供操作系统',
    attempts: state.troubleshooting.length ? state.troubleshooting.map((item, i) => `${i + 1}. ${item.step}：${item.result}`).join('；') : '尚未执行自助排查，保留截图供人工分析',
    status: '待人工核实并处理', urgency: state.urgency,
    screenshots: state.screenshots.map(shot => ({ ...shot }))
  };
}

$$('[data-upload]').forEach(button => button.addEventListener('click', () => {
  if (actionLocked) return;
  $('#screenshotInput').click();
}));
$('#screenshotInput').addEventListener('change', event => selectScreenshot(event.target.files[0]));
[heroInput, chatInput].forEach(input => input.addEventListener('paste', event => {
  const file = [...(event.clipboardData?.files || [])].find(item => item.type.startsWith('image/'));
  if (file) { event.preventDefault(); selectScreenshot(file); }
}));
document.addEventListener('click', event => {
  if (event.target.closest('[data-remove-screenshot]')) clearPendingScreenshot();
  const retry = event.target.closest('[data-retry-screenshot]');
  if (retry && !actionLocked) {
    const shot = state.screenshots.find(item => item.id === retry.dataset.retryScreenshot);
    if (shot) analyzeScreenshot(shot);
  }
  const target = event.target.closest('[data-screenshot]');
  if (!target) return;
  const shots = [...state.screenshots, ...state.tickets.flatMap(ticket => ticket.draft?.screenshots || [])];
  const shot = shots.find(item => item.id === target.dataset.screenshot);
  if (!shot) return;
  $('#fullScreenshot').src = shot.preview;
  $('#screenshotDialog').showModal();
});
$('#closeScreenshot').addEventListener('click', () => $('#screenshotDialog').close());
updateAttachmentUI();
