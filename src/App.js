import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styled, { createGlobalStyle, ThemeProvider } from 'styled-components';

/* ---------- Theme ---------- */
const theme = {
  bg: '#0c0e12',
  surface: '#141820',
  surface2: '#1a1f2a',
  border: 'rgba(255, 255, 255, 0.08)',
  text: '#e8eaef',
  muted: '#8b92a5',
  accentA: '#5eead4',
  accentB: '#a78bfa',
  danger: '#f87171',
  radius: 12,
  font: '"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
};

/** One user message + Agent A reply = one volley; B dreams after this many volleys. */
const DEFAULT_VOLLEYS_PER_DREAM = 3;
const MIN_VOLLEYS_PER_DREAM = 1;
const MAX_VOLLEYS_PER_DREAM = 12;

/** 앱 전체 최소 너비 — 좁은 뷰포트에서는 가로 스크롤 */
const APP_MIN_WIDTH_PX = 1200;

const GlobalStyle = createGlobalStyle`
  *, *::before, *::after { box-sizing: border-box; }
  html {
    min-height: 100%;
    overflow-x: auto;
    overflow-y: hidden;
  }
  body {
    margin: 0;
    height: 100%;
    min-width: ${APP_MIN_WIDTH_PX}px;
    overflow: hidden;
    background: ${(p) => p.theme.bg};
    color: ${(p) => p.theme.text};
    font-family: ${(p) => p.theme.font};
    -webkit-font-smoothing: antialiased;
  }
  #root {
    height: 100%;
    min-height: 0;
    min-width: ${APP_MIN_WIDTH_PX}px;
    display: flex;
    flex-direction: column;
  }
  /* 스크롤 동작은 유지, 스크롤바만 숨김 */
  * {
    scrollbar-width: none;
    -ms-overflow-style: none;
  }
  *::-webkit-scrollbar {
    width: 0;
    height: 0;
    background: transparent;
  }
`;

const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

/**
 * OpenAI REST 베이스 URL (한 곳에서만 관리).
 * 브라우저에서 api.openai.com 직접 호출 시 CORS로 막히면 .env에
 * REACT_APP_OPENAI_BASE_URL=https://내-프록시-주소 처럼 백엔드 프록시를 둔다.
 */
const OPENAI_API_BASE =
  (process.env.REACT_APP_OPENAI_BASE_URL && process.env.REACT_APP_OPENAI_BASE_URL.trim().replace(/\/$/, '')) ||
  'https://api.openai.com';

/**
 * Chat Completions 호출. content만 반환.
 * @param {object} [options] — { model?, logLabel? }
 */
async function callOpenAiChat(apiKey, messages, options = {}) {
  const model = options.model ?? DEFAULT_OPENAI_MODEL;
  const logLabel = options.logLabel ?? 'OpenAI';
  const url = `${OPENAI_API_BASE}/v1/chat/completions`;
  const body = {
    model,
    messages,
    temperature: 0.75,
    max_tokens: 1024,
  };
  console.log(`[Dreaming Agent · OpenAI · Request] ${logLabel}`, { url, ...body });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText || 'OpenAI 요청 실패';
    console.log(`[Dreaming Agent · OpenAI · Error] ${logLabel}`, {
      status: res.status,
      statusText: res.statusText,
      error: msg,
      response: data,
    });
    throw new Error(msg);
  }
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('OpenAI 응답이 비어 있음');
  console.log(`[Dreaming Agent · OpenAI · Response] ${logLabel}`, text);
  return text;
}

/** Agent A용: 기억 스트림 항목을 시간 순으로 이어붙임(구분 라벨 없음). */
function buildMemoryContextForAgent(memoryTail) {
  const parts = memoryTail
    .slice(-12)
    .map((m) => m.text.trim())
    .filter(Boolean);
  return parts.join('\n\n').slice(0, 2800);
}

const SYSTEM_AGENT_A = `
  너는 "Dreaming Agent"의 대화 파트너(Agent A)다.
  대화 기록에 이어지는 user/assistant 메시지는 모두 같은 세션의 연속 대화다.
  가독성을 위해 필요하면 마크다운을 써도 된다(예: **굵게**, 목록, 소제목 ##, 인용 >).
  언어는 사용자의 언어를 따라간다.
  이 메시지 아래에 "과거 기억" 블록이 붙으면, 그것은 user/assistant 채팅과 별도로 쌓인 요약·꿈 발췌다. 필요할 때만 가볍게 반영한다.
  `;

/** API 토큰 한도 고려해 최근 말풍선만 전달 */
const MAX_OPENAI_CHAT_TURNS = 40;

/**
 * 채팅 말풍선 이력 → OpenAI messages. 과거 기억 발췌는 system 하단에만 붙인다.
 */
function buildOpenAiMessagesFromHistory(history, memoryContextTail) {
  const sliced =
    history.length > MAX_OPENAI_CHAT_TURNS ? history.slice(-MAX_OPENAI_CHAT_TURNS) : history;
  const mem = memoryContextTail && memoryContextTail.trim() ? memoryContextTail.trim() : '';

  const baseSystem = SYSTEM_AGENT_A.trim();
  const systemContent = mem
    ? `${baseSystem}\n\n---\n과거 기억:\n${mem}`
    : baseSystem;

  const messages = [{ role: 'system', content: systemContent }];
  for (let i = 0; i < sliced.length; i++) {
    const m = sliced[i];
    const role = m.kind === 'user' ? 'user' : 'assistant';
    messages.push({ role, content: m.text });
  }
  return messages;
}

const SYSTEM_SUMMARY_BATCH = `
  너는 대화 로그를 압축하는 역할이다.
  "You"/"Reply" 형식의 영어 라벨이 붙은 대화를 2~3문장 사용자의 언어로 요약한다.
  직접 인용은 피하고 흐름과 초점만 남긴다.
  `;

/** 기억 스트림 dream 체인: 1 키워드 → 2 상위 범주화 → 3 범주 내 재구성 → 4 장면 */
const DREAM_CHAIN_KEYWORDS = `너는 대화에서 핵심을 짚는 분석가다.
아래는 "You"/"Reply" 라벨이 붙은 대화 로그다.
주제·감정·구체적 사물/상황을 반영해 핵심 키워드를 정확히 5개만 뽑아라.
출력 형식: 번호나 기호 없이 한 줄에 하나씩, 딱 5줄만. 다른 설명은 쓰지 마라.`;

const DREAM_CHAIN_SUPERCLASS = `너는 키워드를 상위 범주로 올리는 역할이다.
입력으로 키워드 5줄이 주어진다. 각 줄에 대해 "한 단계 위 범주"를 제시하라.
규칙:
1) 원 키워드를 반복하지 말 것
2) 너무 포괄적인 단어(것, 대상, 행위, 감정 등) 금지
3) 사람이 직관적으로 이해 가능한 중간 범주를 택할 것
출력 형식: 한 줄에 하나씩 5줄, 불릿/번호 없이.`;

const DREAM_CHAIN_REINTERPRET = `너는 "상위 범주"를 다시 구체화하는 역할이다.
입력으로 원 키워드 5줄과 상위 범주 5줄이 함께 주어진다.
각 항목마다 상위 범주 안에서 원 키워드와 비슷하지만 동일하지 않은 대상을 하나 골라라.
의도: 커피 > 음료 > 말차라떼처럼, 한 단계 올렸다가 다른 지점으로 내려와 의미가 살짝 비틀리게 만들기.
규칙:
1) 원 키워드 자체/동의어는 금지
2) 범주를 벗어나면 안 됨
3) 너무 동떨어진 항목도 금지(같은 장면에서 자연스럽게 공존할 정도의 근접성 유지)
출력 형식: 한 줄에 하나씩 5줄, 불릿/번호 없이.`;

const DREAM_CHAIN_STORY = `너는 짧은 장면 작성자다.
아래 변환된 단서 5개를 모두 반영해 하나의 장면을 써라.
문체는 현실적인 대화 또는 일상 서술이면 된다.
출력 길이: 2~4문장.`;

const DREAM_CHAIN_MEMORY_SUMMARY = `너는 장면을 memory stream용으로 압축하는 역할이다.
입력 장면을 인용/따옴표/이름 없이 2~3문장으로 요약하라.
핵심 흐름과 정서만 남기고 원문 문장 복붙은 피하라.
고유명사가 보이면 일반 표현(예: 한 사람, 다른 사람)으로 치환하라.`;

/**
 * volley 대화 snippet + 배치 요약 summaryText 로 꿈 체인 5회 호출 → 최종 dream 문자열
 */
async function runDreamPromptChain(apiKey, snippet, summaryText, onStep, isCancelled) {
  if (isCancelled?.()) throw new Error('cancelled');
  const userLog = `다음은 이번 volley 구간의 대화 로그다.\n\n${snippet}`;

  onStep?.(1);
  const keywordsRaw = await callOpenAiChat(
    apiKey,
    [
      { role: 'system', content: DREAM_CHAIN_KEYWORDS.trim() },
      { role: 'user', content: userLog },
    ],
    { logLabel: 'memory stream · dream chain 1/5 키워드 추출' }
  );
  if (isCancelled?.()) throw new Error('cancelled');

  onStep?.(2);
  const superclassesRaw = await callOpenAiChat(
    apiKey,
    [
      { role: 'system', content: DREAM_CHAIN_SUPERCLASS.trim() },
      {
        role: 'user',
        content: `다음 키워드 5개를 상위 범주로 올려라:\n\n${keywordsRaw}`,
      },
    ],
    { logLabel: 'memory stream · dream chain 2/5 상위 범주화' }
  );
  if (isCancelled?.()) throw new Error('cancelled');

  onStep?.(3);
  const reinterpretRaw = await callOpenAiChat(
    apiKey,
    [
      { role: 'system', content: DREAM_CHAIN_REINTERPRET.trim() },
      {
        role: 'user',
        content: `원 키워드들:\n${keywordsRaw}\n\n상위 범주들:\n${superclassesRaw}\n\n규칙에 맞게 각 항목을 범주 내에서 다시 구체화하라.`,
      },
    ],
    { logLabel: 'memory stream · dream chain 3/5 범주 내 재구성' }
  );
  if (isCancelled?.()) throw new Error('cancelled');

  onStep?.(4);
  const storyRaw = await callOpenAiChat(
    apiKey,
    [
      { role: 'system', content: DREAM_CHAIN_STORY.trim() },
      {
        role: 'user',
        content: `재구성된 단서들:\n${reinterpretRaw}\n\n---\n직전 대화 요약(분위기 참고만, 문장을 베끼지 말 것):\n${summaryText}`,
      },
    ],
    { logLabel: 'memory stream · dream chain 4/5 장면 생성' }
  );
  if (isCancelled?.()) throw new Error('cancelled');

  onStep?.(5);
  const memorySummaryRaw = await callOpenAiChat(
    apiKey,
    [
      { role: 'system', content: DREAM_CHAIN_MEMORY_SUMMARY.trim() },
      { role: 'user', content: storyRaw },
    ],
    { logLabel: 'memory stream · dream chain 5/5 메모리 요약' }
  );
  if (isCancelled?.()) throw new Error('cancelled');
  return memorySummaryRaw.trim();
}

/* ---------- Styled ---------- */
const Shell = styled.div`
  height: 100vh;
  max-height: 100vh;
  min-height: 0;
  min-width: ${APP_MIN_WIDTH_PX}px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
`;

const TopBar = styled.header`
  flex-shrink: 0;
  padding: 1.25rem 1.5rem;
  border-bottom: 1px solid ${(p) => p.theme.border};
  background: linear-gradient(180deg, ${(p) => p.theme.surface} 0%, ${(p) => p.theme.bg} 100%);
`;

const Title = styled.h1`
  margin: 0;
  font-size: 1.25rem;
  font-weight: 700;
  letter-spacing: -0.02em;
`;

const Sub = styled.p`
  margin: 0.35rem 0 0;
  font-size: 0.85rem;
  color: ${(p) => p.theme.muted};
  line-height: 1.45;
  max-width: 52rem;
`;

const TopBarRow = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
`;

const DreamingPill = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.45rem 0.85rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  border: 1px solid ${(p) => (p.$on ? p.theme.accentB + '99' : p.theme.border)};
  background: ${(p) => (p.$on ? p.theme.accentB + '22' : p.theme.surface2)};
  color: ${(p) => (p.$on ? p.theme.accentB : p.theme.muted)};
  box-shadow: ${(p) => (p.$on ? `0 0 24px ${p.theme.accentB}55, inset 0 0 20px ${p.theme.accentB}18` : 'none')};
  transition:
    background 0.35s ease,
    box-shadow 0.35s ease,
    border-color 0.35s ease,
    color 0.35s ease;
  flex-shrink: 0;
`;

const DreamingMoon = styled.span`
  font-size: 0.95rem;
  line-height: 1;
  filter: ${(p) => (p.$on ? 'drop-shadow(0 0 8px rgba(167, 139, 250, 0.9))' : 'grayscale(1) opacity(0.45)')};
  transition: filter 0.35s ease;
`;

const DreamingStrip = styled.div`
  height: 4px;
  width: 100%;
  margin-top: 1rem;
  border-radius: 2px;
  overflow: hidden;
  background: ${(p) => p.theme.border};
  position: relative;
  &::after {
    content: '';
    position: absolute;
    inset: 0;
    opacity: ${(p) => (p.$active ? 1 : 0)};
    background: linear-gradient(
      90deg,
      ${(p) => p.theme.accentB}00,
      ${(p) => p.theme.accentB},
      ${(p) => p.theme.accentA},
      ${(p) => p.theme.accentB},
      ${(p) => p.theme.accentB}00
    );
    background-size: 200% 100%;
    animation: ${(p) => (p.$active ? 'dreamflow 2.2s ease-in-out infinite' : 'none')};
  }
  @keyframes dreamflow {
    0% {
      transform: translateX(-50%) scaleX(0.6);
      opacity: 0.5;
    }
    50% {
      transform: translateX(0%) scaleX(1);
      opacity: 1;
    }
    100% {
      transform: translateX(50%) scaleX(0.6);
      opacity: 0.5;
    }
  }
`;

const SessionCard = styled.div`
  flex-shrink: 0;
  border-radius: ${(p) => p.theme.radius}px;
  border: 1px solid ${(p) => p.theme.border};
  background: ${(p) => p.theme.surface2};
  padding: 0.75rem 0.9rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.78rem;
  color: ${(p) => p.theme.muted};
`;

/** Session 카드와 동일한 틀 안에 volley 숫자만 입력 */
const VolleysCard = styled.div`
  flex-shrink: 0;
  border-radius: ${(p) => p.theme.radius}px;
  border: 1px solid ${(p) => p.theme.border};
  background: ${(p) => p.theme.surface2};
  padding: 0.75rem 0.9rem;
  display: flex;
  align-items: center;
  transition: border-color 0.15s ease;
  &:focus-within {
    border-color: ${(p) => p.theme.accentA};
  }
`;

const VolleysInput = styled.input`
  flex: 1;
  min-width: 0;
  width: 100%;
  border: none;
  background: transparent;
  color: ${(p) => p.theme.muted};
  font-family: inherit;
  font-size: 0.78rem;
  line-height: 1.35;
  outline: none;
  -moz-appearance: textfield;
  appearance: textfield;
  &::-webkit-outer-spin-button,
  &::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
`;

const ApiKeyBlock = styled.div`
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
`;

const ApiKeyInput = styled.input`
  width: 100%;
  padding: 0.45rem 0.55rem;
  border-radius: ${(p) => p.theme.radius}px;
  border: 1px solid ${(p) => p.theme.border};
  background: ${(p) => p.theme.bg};
  color: ${(p) => p.theme.text};
  font-family: ui-monospace, monospace;
  font-size: 0.72rem;
  outline: none;
  &::placeholder {
    color: ${(p) => p.theme.muted};
    opacity: 0.85;
  }
  &:focus {
    border-color: ${(p) => p.theme.accentA};
  }
`;

const Main = styled.main`
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: grid;
  grid-template-columns: 280px 1fr 320px;
  grid-template-rows: minmax(0, 1fr);
  gap: 0;

  & > * {
    min-height: 0;
  }
`;

const Panel = styled.aside`
  border-right: 1px solid ${(p) => p.theme.border};
  padding: 1rem;
  background: ${(p) => p.theme.surface};
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-height: 0;
  overflow: hidden;
`;

const PanelTitle = styled.h2`
  flex-shrink: 0;
  margin: 0;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: ${(p) => p.theme.muted};
`;

const Dot = styled.span`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: ${(p) => p.$color};
  box-shadow: 0 0 12px ${(p) => p.$color};
  animation: ${(p) => (p.$pulse ? 'pulse 1.2s ease-in-out infinite' : 'none')};

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: 0.5;
      transform: scale(0.85);
    }
  }
`;

const ActivityLog = styled.div`
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  border-radius: ${(p) => p.theme.radius}px;
  border: 1px solid ${(p) => p.theme.border};
  background: ${(p) => p.theme.bg};
  padding: 0.5rem;
  font-size: 0.72rem;
  color: ${(p) => p.theme.muted};
  font-family: ui-monospace, monospace;
`;

const LogLine = styled.div`
  padding: 0.2rem 0;
  border-bottom: 1px solid ${(p) => p.theme.border};
  &:last-child {
    border-bottom: none;
  }
`;

const ChatColumn = styled.section`
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  background: ${(p) => p.theme.bg};
`;

const ChatHeader = styled.div`
  flex-shrink: 0;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid ${(p) => p.theme.border};
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
`;

const ChatHeaderText = styled.div`
  flex: 1;
  min-width: 200px;
`;

const ChatTitle = styled.h2`
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
`;

const ChatHint = styled.p`
  margin: 0.25rem 0 0;
  font-size: 0.8rem;
  color: ${(p) => p.theme.muted};
`;

const HeaderActions = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.35rem;
`;

const Messages = styled.div`
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
`;

const Bubble = styled.div`
  align-self: ${(p) => (p.$user ? 'flex-end' : 'flex-start')};
  max-width: min(92%, 36rem);
  padding: 0.75rem 1rem;
  border-radius: ${(p) => p.theme.radius}px;
  font-size: 0.9rem;
  line-height: 1.5;
  background: ${(p) => (p.$user ? p.theme.accentA + '22' : p.theme.surface2)};
  border: 1px solid ${(p) => p.theme.border};
  color: ${(p) => p.theme.text};
`;

const Meta = styled.span`
  display: block;
  margin-top: 0.35rem;
  font-size: 0.7rem;
  color: ${(p) => p.theme.muted};
`;

/** 채팅·메모리 공통 마크다운 스타일 ($memory: 오른쪽 패널용 작은 글자) */
const MarkdownShell = styled.div`
  color: inherit;
  font-size: ${(p) => (p.$memory ? '0.82rem' : '0.9rem')};
  line-height: ${(p) => (p.$memory ? 1.45 : 1.5)};

  & p {
    margin: 0 0 0.65em;
    &:last-child {
      margin-bottom: 0;
    }
  }
  & ul,
  & ol {
    margin: 0.4em 0;
    padding-left: 1.35rem;
  }
  & li {
    margin: 0.25em 0;
  }
  & li > p {
    margin: 0;
  }
  & strong {
    font-weight: 600;
    color: ${(p) => p.theme.text};
  }
  & em {
    font-style: italic;
  }
  & h1 {
    font-size: 1.08em;
  }
  & h2 {
    font-size: 1.02em;
  }
  & h3 {
    font-size: 0.98em;
  }
  & h1,
  & h2,
  & h3 {
    margin: 0.55em 0 0.4em;
    font-weight: 600;
    line-height: 1.35;
    &:first-child {
      margin-top: 0;
    }
  }
  & code {
    font-family: ui-monospace, monospace;
    font-size: 0.88em;
    padding: 0.12em 0.35em;
    border-radius: 4px;
    background: ${(p) => p.theme.bg};
    border: 1px solid ${(p) => p.theme.border};
  }
  & pre {
    margin: 0.5em 0;
    padding: 0.55rem 0.7rem;
    border-radius: 8px;
    overflow: auto;
    background: ${(p) => p.theme.bg};
    border: 1px solid ${(p) => p.theme.border};
    font-size: 0.86em;
    line-height: 1.45;
  }
  & pre code {
    padding: 0;
    border: none;
    background: transparent;
    font-size: inherit;
  }
  & blockquote {
    margin: 0.45em 0;
    padding: 0.2em 0 0.2em 0.75em;
    border-left: 3px solid ${(p) => p.theme.accentB + '99'};
    color: ${(p) => p.theme.muted};
  }
  & hr {
    border: none;
    border-top: 1px solid ${(p) => p.theme.border};
    margin: 0.65em 0;
  }
  & table {
    border-collapse: collapse;
    width: 100%;
    margin: 0.5em 0;
    font-size: 0.92em;
  }
  & th,
  & td {
    border: 1px solid ${(p) => p.theme.border};
    padding: 0.35em 0.5em;
    text-align: left;
  }
  & th {
    background: ${(p) => p.theme.surface};
  }
  & a {
    color: ${(p) => p.theme.accentA};
    text-decoration: underline;
    text-underline-offset: 2px;
    word-break: break-word;
  }
`;

const markdownComponents = {
  a: ({ children, href, ...rest }) => (
    <a href={href} {...rest} target="_blank" rel="noreferrer noopener">
      {children != null && String(children).trim() !== '' ? children : href || '링크'}
    </a>
  ),
};

function MarkdownMessage({ text, $memory }) {
  const src = text ?? '';
  return (
    <MarkdownShell $memory={$memory}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {src}
      </ReactMarkdown>
    </MarkdownShell>
  );
}

const Composer = styled.div`
  flex-shrink: 0;
  padding: 1rem 1.25rem 1.25rem;
  border-top: 1px solid ${(p) => p.theme.border};
  display: flex;
  gap: 0.5rem;
  align-items: stretch;

  & > button {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    align-self: stretch;
    min-height: 36px;
    padding: 0.45rem 1rem;
  }
`;

const TextArea = styled.textarea`
  flex: 1;
  min-height: 36px;
  max-height: 120px;
  resize: vertical;
  line-height: 1.4;
  border-radius: ${(p) => p.theme.radius}px;
  border: 1px solid ${(p) => p.theme.border};
  background: ${(p) => p.theme.surface};
  color: ${(p) => p.theme.text};
  padding: 0.45rem 0.7rem;
  font-family: inherit;
  font-size: 0.875rem;
  outline: none;
  &:focus {
    border-color: ${(p) => p.theme.accentA};
  }
`;

const Button = styled.button`
  border: none;
  border-radius: ${(p) => p.theme.radius}px;
  padding: 0.65rem 1.1rem;
  font-weight: 600;
  font-size: 0.85rem;
  cursor: pointer;
  font-family: inherit;
  background: ${(p) => (p.$secondary ? p.theme.surface2 : p.theme.accentA)};
  color: ${(p) => (p.$secondary ? p.theme.text : '#042f2e')};
  border: 1px solid ${(p) => (p.$secondary ? p.theme.border : 'transparent')};
  opacity: ${(p) => (p.$disabled ? 0.45 : 1)};
  pointer-events: ${(p) => (p.$disabled ? 'none' : 'auto')};
  white-space: nowrap;
  &:hover {
    filter: brightness(1.06);
  }
`;

const MemoryColumn = styled.aside`
  border-left: 1px solid ${(p) => p.theme.border};
  background: ${(p) => p.theme.surface};
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
`;

const MemoryHeader = styled.div`
  flex-shrink: 0;
  padding: 1rem 1rem 0.5rem;
`;

const MemoryList = styled.div`
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 0.5rem 1rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
`;

const MemoryCard = styled.article`
  border-radius: ${(p) => p.theme.radius}px;
  border: 1px solid ${(p) => p.theme.border};
  background: ${(p) => p.theme.surface2};
  padding: 0.65rem 0.75rem;
  border-left: 3px solid ${(p) => p.$accent};
`;

const Chip = styled.span`
  display: inline-block;
  font-size: 0.65rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: ${(p) => p.$fg};
  margin-bottom: 0.35rem;
`;

const MemoryText = styled.p`
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.45;
  color: ${(p) => p.theme.text};
`;

/* ---------- App ---------- */
function App() {
  /** 채팅창 말풍선용 (턴 단위) */
  const [chatTurns, setChatTurns] = useState([]);
  /** 통합 기억: dialogue_batch(N volley마다 1) + dream(동일 주기) 만 */
  const [memoryLog, setMemoryLog] = useState([]);
  /** 핑퐁 N번마다 memory + dream (설정 가능) */
  const [volleysPerDream, setVolleysPerDream] = useState(DEFAULT_VOLLEYS_PER_DREAM);
  /** 입력 중 빈 칸·삭제 허용; 확정은 blur에서 volleysPerDream에 반영 */
  const [volleysDraft, setVolleysDraft] = useState(String(DEFAULT_VOLLEYS_PER_DREAM));
  const [input, setInput] = useState('');
  /** 비어 있으면 로컬 패턴 답변·합성 꿈 사용 */
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [agentAStatus, setAgentAStatus] = useState('idle');
  const [agentBStatus, setAgentBStatus] = useState('idle');
  const [activity, setActivity] = useState([]);
  const messagesEndRef = useRef(null);
  const memoryLogRef = useRef(memoryLog);
  const chatTurnsRef = useRef(chatTurns);
  const openaiKeyRef = useRef('');
  /** OpenAI 배치 처리 중복 실행 방지(Strict Mode·레이스) */
  const openAiBatchInflightRef = useRef(new Set());

  useEffect(() => {
    memoryLogRef.current = memoryLog;
  }, [memoryLog]);

  useEffect(() => {
    chatTurnsRef.current = chatTurns;
  }, [chatTurns]);

  useEffect(() => {
    openaiKeyRef.current = openaiApiKey.trim();
  }, [openaiApiKey]);

  const pushActivity = useCallback((line) => {
    setActivity((prev) => {
      const next = [...prev, { t: Date.now(), line }];
      return next.slice(-40);
    });
  }, []);

  const chatMessages = useMemo(() => chatTurns, [chatTurns]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [chatMessages, agentAStatus]);

  /**
   * N volley마다: 기억 스트림에 대화 요약 1개 → 이어서 꿈 1개
   * deps에 memoryLog를 넣지 않음 — dialogue_batch 추가 시 effect가 다시 돌면서 cleanup이 꿈 타이머를 지우는 문제 방지
   */
  useEffect(() => {
    if (chatTurns.length === 0) return;
    const last = chatTurns[chatTurns.length - 1];
    if (last.kind !== 'agent') return;
    const agentCount = chatTurns.filter((m) => m.kind === 'agent').length;
    if (agentCount <= 0 || agentCount % volleysPerDream !== 0) return;

    const mem = memoryLogRef.current;
    /** 세션 리셋 후에도 배치가 다시 1번부터 세지지 않도록, 이 배치의 마지막 agent 메시지 id로 중복만 방지 */
    if (mem.some((m) => m.kind === 'dialogue_batch' && m.anchorAgentId === last.id)) return;

    const batchDialogue = chatTurns.slice(-volleysPerDream * 2);
    const snippet = batchDialogue
      .map((m) => `${m.kind === 'user' ? 'You' : 'Reply'}: ${m.text}`)
      .join('\n');
    const cycleId = mem.filter((m) => m.kind === 'dream').length + 1;
    const batchSeq = mem.filter((m) => m.kind === 'dialogue_batch').length + 1;
    const apiKey = openaiKeyRef.current;

    /** OpenAI: 요약 → 꿈 순 비동기 */
    if (apiKey) {
      const inflight = openAiBatchInflightRef.current;
      if (inflight.has(last.id)) return;
      inflight.add(last.id);
      let cancelled = false;
      setAgentBStatus('dreaming');
      pushActivity(`[dream] recomposition started (#${cycleId}) — OpenAI`);
      pushActivity(`[memory] dialogue batch #${batchSeq} folding (API)…`);

      (async () => {
        try {
          const summaryText = await callOpenAiChat(
            apiKey,
            [
              { role: 'system', content: SYSTEM_SUMMARY_BATCH },
              { role: 'user', content: snippet },
            ],
            { logLabel: 'memory stream · volley 대화 요약(dialogue_batch)' }
          );
          if (cancelled) return;
          setMemoryLog((prev) => {
            if (prev.some((m) => m.kind === 'dialogue_batch' && m.anchorAgentId === last.id)) return prev;
            return [
              ...prev,
              {
                id: `dialogue-batch-${last.id}-${Date.now()}`,
                kind: 'dialogue_batch',
                text: summaryText,
                ts: Date.now(),
                anchorAgentId: last.id,
              },
            ];
          });
          pushActivity(`[memory] dialogue batch #${batchSeq} folded (API)`);

          const dreamChainLabels = ['키워드 추출', '상위 범주화', '범주 내 재구성', '장면 생성', '메모리 요약'];
          const dreamText = await runDreamPromptChain(
            apiKey,
            snippet,
            summaryText,
            (step) => {
              pushActivity(`[dream] chain ${step}/5 — ${dreamChainLabels[step - 1]}`);
            },
            () => cancelled
          );
          if (cancelled) return;
          setMemoryLog((prev) => {
            if (prev.some((m) => m.kind === 'dream' && m.anchorAgentId === last.id)) return prev;
            return [
              ...prev,
              {
                id: `dream-${cycleId}-${Date.now()}`,
                kind: 'dream',
                text: dreamText,
                ts: Date.now(),
                cycleId,
                anchorAgentId: last.id,
              },
            ];
          });
          pushActivity(`[dream] shard merged into memory stream (API)`);
        } catch (e) {
          if (cancelled) return;
          if (e?.message === 'cancelled') return;
          const errMsg = String(e?.message || e);
          pushActivity(`[dream] OpenAI 호출 실패: ${errMsg}`);
          window.alert(`꿈 생성 실패\n\n${errMsg}`);
        } finally {
          inflight.delete(last.id);
          if (!cancelled) setAgentBStatus('idle');
        }
      })();

      return () => {
        cancelled = true;
        inflight.delete(last.id);
        setAgentBStatus('idle');
      };
    }

    /** API 키 없으면 꿈·기억 배치 미실행 (전송 단계에서 이미 차단) */
    return undefined;
  }, [chatTurns, volleysPerDream, pushActivity]);

  const handleReset = useCallback(() => {
    setChatTurns([]);
    setActivity([]);
    setInput('');
    setAgentAStatus('idle');
    setAgentBStatus('idle');
    pushActivity('[SYS] session cleared — chat cleared, memory stream kept');
  }, [pushActivity]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || agentAStatus === 'thinking' || agentBStatus === 'dreaming') return;

    const apiKey = openaiKeyRef.current;
    if (!apiKey) {
      window.alert('OpenAI API 키를 왼쪽 Session 패널에 입력해 주세요.');
      return;
    }

    const userEntry = { id: `u-${Date.now()}`, kind: 'user', text, ts: Date.now() };

    const historyForApi = [...chatTurnsRef.current, userEntry];

    setChatTurns((prev) => [...prev, userEntry]);
    setInput('');
    /** 한글 IME 등으로 조합 중 Enter 시 마지막 글자가 남는 경우 보조 제거 */
    requestAnimationFrame(() => setInput(''));

    setAgentAStatus('thinking');
    pushActivity('[chat] message received');

    const appendAgentReply = (reply) => {
      const agentEntry = { id: `a-${Date.now()}`, kind: 'agent', text: reply, ts: Date.now() };
      setChatTurns((prev) => [...prev, agentEntry]);
      pushActivity('[chat] reply saved');
      setAgentAStatus('idle');
    };

    (async () => {
      try {
        const tail = memoryLogRef.current.slice(-16);
        const ctx = buildMemoryContextForAgent(tail);
        const messagesPayload = buildOpenAiMessagesFromHistory(historyForApi, ctx);
        const reply = await callOpenAiChat(apiKey, messagesPayload, {
          logLabel: 'chat · Agent A (대화)',
        });
        appendAgentReply(reply);
      } catch (e) {
        const errMsg = String(e?.message || e);
        pushActivity(`[chat] OpenAI 호출 실패: ${errMsg}`);
        window.alert(`OpenAI 대화 호출에 실패했습니다.\n\n${errMsg}`);
        setAgentAStatus('idle');
      }
    })();
  }, [input, agentAStatus, agentBStatus, pushActivity]);

  const formatTime = (ts) => {
    try {
      return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  };

  const dreamingOn = agentBStatus === 'dreaming';
  const hasApiKey = openaiApiKey.trim().length > 0;

  return (
    <ThemeProvider theme={theme}>
      <GlobalStyle />
      <Shell>
        <TopBar>
          <TopBarRow>
            <div>
              <Title>Dreaming Agent</Title>
              <Sub>
                An autonomous dreamer generating independent memories for fresh inspiration.
              </Sub>
            </div>
            <DreamingPill $on={dreamingOn} title={dreamingOn ? 'Dreaming: on' : 'Dreaming: off'}>
              <DreamingMoon $on={dreamingOn} aria-hidden>
                ☾
              </DreamingMoon>
              <span>Dreaming {dreamingOn ? 'on' : 'off'}</span>
            </DreamingPill>
          </TopBarRow>
          <DreamingStrip $active={dreamingOn} aria-hidden />
        </TopBar>

        <Main>
          <Panel>
            <PanelTitle>Session</PanelTitle>
            <SessionCard>
              <Dot
                $color={
                  agentAStatus === 'thinking'
                    ? theme.accentA
                    : hasApiKey
                      ? theme.accentA
                      : theme.muted
                }
                $pulse={agentAStatus === 'thinking'}
              />
              <span>
                {agentAStatus === 'thinking'
                  ? 'Taking in your words…'
                  : hasApiKey
                    ? 'Ready'
                    : 'OpenAI API key required'}
              </span>
            </SessionCard>

            <PanelTitle style={{ marginTop: '0.25rem' }}>Volleys per dream</PanelTitle>
            <VolleysCard>
              <VolleysInput
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={volleysDraft}
                onChange={(e) => {
                  setVolleysDraft(e.target.value.replace(/\D/g, ''));
                }}
                onBlur={() => {
                  if (volleysDraft === '') {
                    setVolleysPerDream(DEFAULT_VOLLEYS_PER_DREAM);
                    setVolleysDraft(String(DEFAULT_VOLLEYS_PER_DREAM));
                    return;
                  }
                  const v = parseInt(volleysDraft, 10);
                  if (Number.isNaN(v)) {
                    setVolleysPerDream(DEFAULT_VOLLEYS_PER_DREAM);
                    setVolleysDraft(String(DEFAULT_VOLLEYS_PER_DREAM));
                    return;
                  }
                  const clamped = Math.min(MAX_VOLLEYS_PER_DREAM, Math.max(MIN_VOLLEYS_PER_DREAM, v));
                  setVolleysPerDream(clamped);
                  setVolleysDraft(String(clamped));
                }}
                aria-label={`Volleys per dream, ${MIN_VOLLEYS_PER_DREAM} to ${MAX_VOLLEYS_PER_DREAM}`}
              />
            </VolleysCard>
            <PanelTitle style={{ marginTop: '0.25rem' }}>Activity log</PanelTitle>
            <ActivityLog>
              {activity.length === 0 && <div>Events will appear here.</div>}
              {activity.map((a) => (
                <LogLine key={a.t + a.line}>
                  {formatTime(a.t)} {a.line}
                </LogLine>
              ))}
            </ActivityLog>
            <ApiKeyBlock>
              <PanelTitle>OpenAI API key</PanelTitle>
              <ApiKeyInput
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-…"
                value={openaiApiKey}
                onChange={(e) => setOpenaiApiKey(e.target.value)}
                aria-label="OpenAI API key"
              />
            </ApiKeyBlock>
          </Panel>

          <ChatColumn>
            <ChatHeader>
              <ChatHeaderText>
                <ChatTitle>Conversation</ChatTitle>
                <ChatHint>
                  Every {volleysPerDream} volleys, the agent weaves one memory and one dream.
                </ChatHint>
              </ChatHeaderText>
              <HeaderActions>
                <Button type="button" $secondary onClick={handleReset}>
                  Reset session
                </Button>
              </HeaderActions>
            </ChatHeader>
            <Messages>
              {chatMessages.length === 0 && (
                <Bubble $user={false}>
                  <MarkdownMessage text={"Hello, I'm Dreaming Agent."} />
                  <Meta>Intro</Meta>
                </Bubble>
              )}
              {chatMessages.map((m) => (
                <Bubble key={m.id} $user={m.kind === 'user'}>
                  <MarkdownMessage text={m.text} />
                  <Meta>{m.kind === 'user' ? 'You' : 'Reply'} · {formatTime(m.ts)}</Meta>
                </Bubble>
              ))}
              {agentAStatus === 'thinking' && (
                <Bubble $user={false}>
                  …
                  <Meta>Reply · thinking</Meta>
                </Bubble>
              )}
              <div ref={messagesEndRef} />
            </Messages>
            <Composer>
              <TextArea
                rows={1}
                placeholder="Type a message…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.shiftKey) return;
                  /** 조합 중 Enter는 보내지 않음 — 미확정 글자가 인풋에 남는 현상 방지 */
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  e.preventDefault();
                  handleSend();
                }}
              />
              <Button
                type="button"
                onClick={handleSend}
                $disabled={
                  !openaiApiKey.trim() || agentAStatus === 'thinking' || agentBStatus === 'dreaming'
                }
              >
                Send
              </Button>
            </Composer>
          </ChatColumn>

          <MemoryColumn>
            <MemoryHeader>
              <PanelTitle>Memory stream</PanelTitle>
            </MemoryHeader>
            <MemoryList>
              {memoryLog.length === 0 && (
                <MemoryText style={{ color: theme.muted, fontSize: '0.8rem' }}>
                  No memory yet. Say something to begin.
                </MemoryText>
              )}
              {memoryLog.map((m) => {
                const accent = m.kind === 'dream' ? theme.accentB : theme.accentA;
                const label = m.kind === 'dream' ? 'Dream' : 'Memory';
                return (
                  <MemoryCard key={m.id} $accent={accent}>
                    <Chip $fg={accent}>{label}</Chip>
                    <MarkdownMessage text={m.text} $memory />
                    <Meta>{formatTime(m.ts)}</Meta>
                  </MemoryCard>
                );
              })}
            </MemoryList>
          </MemoryColumn>
        </Main>
      </Shell>
    </ThemeProvider>
  );
}

export default App;
