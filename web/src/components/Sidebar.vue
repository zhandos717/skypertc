<script setup>
import { ref, computed } from 'vue';
import { state } from '../stores/app.js';
import { join } from '../composables/useSignaling.js';
import Icon from './Icon.vue';

const ADJ = ['swift','calm','bright','bold','quiet','sunny','smart','cool','wild','warm','fast','keen','lucky','happy','snappy','clever','brave','jolly','witty','mellow'];
const NOUN = ['tiger','dolphin','panda','wolf','eagle','lynx','otter','heron','falcon','raven','swan','koala','lion','fox','hawk','badger','puffin','orca','seal','crane'];

function randomRoom() {
  const a = ADJ[Math.floor(Math.random() * ADJ.length)];
  const n = NOUN[Math.floor(Math.random() * NOUN.length)];
  return `${a}-${n}-${Math.floor(Math.random() * 900) + 100}`;
}

const roomInput = ref('');
const isPublic = ref(false);
// Lock the visibility toggle only when we're targeting the exact room we
// arrived at via a private invite (URL hash with secret). For any other name
// in the input the user is creating a *new* room → toggle stays free.
const secretLocked = computed(() =>
  !!state.currentSecret && roomInput.value.trim() === (state.currentRoom || '')
);

const meInitial = computed(() => (state.userName || '?').charAt(0).toUpperCase());
const peerList = computed(() => Array.from(state.peers.entries()).filter(([id]) => !state.hiddenPeers.has(id)).map(([, entry]) => entry));

function setVis(pub) {
  if (secretLocked.value) return;
  isPublic.value = pub;
}

function editName() {
  const n = prompt('Ваше имя?', state.userName);
  if (!n) return;
  const trimmed = n.trim();
  if (!trimmed || trimmed === state.userName) return;
  state.userName = trimmed;
  localStorage.setItem('skypertc.name', trimmed);
}

function dice() {
  roomInput.value = randomRoom();
}

async function doJoin() {
  const room = roomInput.value.trim();
  if (!room) return;
  let secret = state.currentSecret;
  if (!isPublic.value && !secret) {
    secret = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  }
  if (isPublic.value) secret = '';
  await join({ room, isPublic: isPublic.value, secret }).catch(console.error);
}

function quickStart() {
  roomInput.value = randomRoom();
  isPublic.value = false;
  doJoin();
}

function pickRoom(name, makePublic = false) {
  roomInput.value = name;
  if (makePublic) isPublic.value = true;
}

defineExpose({ roomInput, setVis });
</script>

<template>
  <aside class="sidebar" :class="{ 'mob-active': state.mobileTab === 'sidebar' }">
    <div class="me">
      <div class="avatar">{{ meInitial }}</div>
      <div class="me-info">
        <div class="me-name-row">
          <div class="me-name">{{ state.userName || 'Гость' }}</div>
          <button class="name-edit-btn" title="Изменить имя" @click="editName">
            <Icon name="pencil" />
          </button>
        </div>
        <div class="me-status"><span class="dot online"></span>В сети</div>
      </div>
    </div>

    <div class="start-call">
      <button class="quick-start" type="button" title="Создать комнату и сразу войти" @click="quickStart">
        <span class="qs-icon"><Icon name="zap" /></span>
        <span class="qs-text">
          <span class="qs-title">Быстрая встреча</span>
          <span class="qs-sub">Создать и войти сразу</span>
        </span>
        <span class="qs-go"><Icon name="chevron-right" /></span>
      </button>

      <div class="or-divider"><span>или присоединиться</span></div>

      <div class="join-form">
        <div class="room-input-wrap">
          <span class="hash-prefix">#</span>
          <input
            v-model="roomInput"
            placeholder="имя комнаты"
            autocomplete="off"
            spellcheck="false"
            @keydown.enter="doJoin"
          />
          <button class="dice-btn" type="button" title="Случайное имя" @click="dice">
            <Icon name="dice-6" />
          </button>
        </div>

        <div class="visibility-seg" role="tablist" aria-label="Видимость комнаты">
          <button
            class="vs-btn"
            :class="{ active: !isPublic }"
            type="button"
            role="tab"
            :aria-selected="!isPublic"
            :disabled="secretLocked"
            @click="setVis(false)"
          >
            <Icon name="lock" /><span>Приватная</span>
          </button>
          <button
            class="vs-btn"
            :class="{ active: isPublic }"
            type="button"
            role="tab"
            :aria-selected="isPublic"
            :disabled="secretLocked"
            @click="setVis(true)"
          >
            <Icon name="globe" /><span>Публичная</span>
          </button>
        </div>

        <button
          class="join-btn join-btn-inline"
          :disabled="!roomInput.trim() || state.joining || state.currentRoom === roomInput.trim()"
          @click="doJoin"
        >
          <Icon name="phone-call" />
          <span v-if="state.joining">Подключение...</span>
          <span v-else-if="state.currentRoom === roomInput.trim()">Вы в комнате</span>
          <span v-else>Присоединиться</span>
        </button>
      </div>
    </div>

    <div class="section-title">Публичные комнаты</div>
    <ul class="contact-list">
      <li v-if="!state.publicRooms.length" class="empty">Пока никого</li>
      <li
        v-for="r in state.publicRooms"
        :key="r.name"
        @click="pickRoom(r.name, true)"
      >
        <div class="avatar small">{{ (r.name || '#').charAt(0).toUpperCase() }}</div>
        <div style="flex:1">
          <div class="name">{{ r.name }}</div>
          <div class="sub">{{ r.count }} в комнате</div>
        </div>
        <span class="count-pill">{{ r.count }}</span>
      </li>
    </ul>

    <div class="section-title">Недавние</div>
    <ul class="contact-list">
      <li v-if="!state.recent.length" class="empty">Здесь появятся комнаты, куда вы заходили</li>
      <li v-for="r in state.recent" :key="r" @click="pickRoom(r)">
        <div class="avatar small">#</div>
        <div><div class="name">{{ r }}</div><div class="sub">Комната</div></div>
      </li>
    </ul>

    <div class="section-title">В комнате</div>
    <ul class="contact-list">
      <li v-if="!peerList.length" class="empty">Вы один в комнате</li>
      <li v-for="p in peerList" :key="p.id">
        <div class="avatar small">{{ (p.name || '?').charAt(0).toUpperCase() }}</div>
        <div>
          <div class="name">{{ p.name }}</div>
          <div class="sub"><span class="dot online"></span>В звонке</div>
        </div>
      </li>
    </ul>
  </aside>
</template>
