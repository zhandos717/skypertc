import { state } from './state.js';

export const TIERS = [
  { name: 'low',   maxBitrate:   120_000, scale: 4,   fps: 12, audio: 16_000, pref: 'balanced' },
  { name: 'med',   maxBitrate:   350_000, scale: 2,   fps: 20, audio: 24_000, pref: 'balanced' },
  { name: 'high',  maxBitrate:   900_000, scale: 1.5, fps: 30, audio: 32_000, pref: 'balanced' },
  { name: 'hd',    maxBitrate: 2_000_000, scale: 1,   fps: 30, audio: 48_000, pref: 'maintain-framerate' },
  { name: 'fhd',   maxBitrate: 4_000_000, scale: 1,   fps: 30, audio: 64_000, pref: 'maintain-framerate' },
  { name: 'ultra', maxBitrate: 6_500_000, scale: 1,   fps: 60, audio: 96_000, pref: 'maintain-framerate' },
];

function classifyQuality(loss, rtt) {
  // loss is fraction (0..1), rtt in seconds.
  if (loss == null && rtt == null) return 'unknown';
  const l = loss ?? 0;
  const r = rtt ?? 0;
  if (l >= 0.08 || r >= 0.45) return 'bad';
  if (l >= 0.03 || r >= 0.25) return 'fair';
  return 'good';
}

export function updateAbrBadge(peerId, tier, loss, rtt, bps, action) {
  const entry = state.peers.get(peerId);
  if (!entry || !entry.tile) return;
  let badge = entry.tile.querySelector('.abr-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'abr-badge';
    entry.tile.appendChild(badge);
  }
  const kbps = bps ? Math.round(bps / 1000) : Math.round(tier.maxBitrate / 1000);
  const lossStr = loss != null ? (loss * 100).toFixed(1) + '%' : '–';
  const rttStr = rtt != null ? Math.round(rtt * 1000) + 'мс' : '–';
  badge.innerHTML = `<span class="abr-tier abr-${tier.name}">${tier.name.toUpperCase()}</span> ${kbps} kbps · ${lossStr} · ${rttStr}`;

  let dot = entry.tile.querySelector('.net-dot');
  if (!dot) {
    dot = document.createElement('div');
    dot.className = 'net-dot';
    dot.title = 'Качество связи';
    entry.tile.appendChild(dot);
  }
  const q = classifyQuality(loss, rtt);
  dot.dataset.q = q;
  dot.title = `Связь: ${q} · потери ${lossStr} · RTT ${rttStr}`;
}

export function makeAbr(pc, peerId) {
  const abrState = {
    tierIdx: 1,
    currentBitrate: TIERS[1].maxBitrate,
    lastPacketsSent: 0,
    lastPacketsLost: 0,
    lastTs: 0,
    goodTicks: 0,
    timer: null,
    probeTicks: 0,
  };

  async function applyTier(idx) {
    idx = Math.max(0, Math.min(TIERS.length - 1, idx));
    const tier = TIERS[idx];
    abrState.tierIdx = idx;
    abrState.currentBitrate = tier.maxBitrate;

    for (const sender of pc.getSenders()) {
      if (!sender.track) continue;
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      if (sender.track.kind === 'video') {
        params.encodings[0].maxBitrate = tier.maxBitrate;
        params.encodings[0].maxFramerate = tier.fps;
        params.encodings[0].scaleResolutionDownBy = tier.scale;
        params.encodings[0].networkPriority = 'high';
        params.encodings[0].priority = 'high';
        params.degradationPreference = tier.pref || 'balanced';
      } else if (sender.track.kind === 'audio') {
        params.encodings[0].maxBitrate = tier.audio;
        params.encodings[0].networkPriority = 'high';
        params.encodings[0].priority = 'high';
      }
      try { await sender.setParameters(params); } catch (e) { console.warn('setParameters', e); }
    }
    updateAbrBadge(peerId, tier, null, null);
  }

  async function setBitrate(bps) {
    bps = Math.max(60_000, Math.min(6_500_000, bps));
    abrState.currentBitrate = bps;
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = bps;
      try { await sender.setParameters(params); } catch {}
    }
  }

  async function tick() {
    if (pc.connectionState !== 'connected') return;
    let stats;
    try { stats = await pc.getStats(); } catch { return; }

    let rtt = 0, lossFraction = 0, availOut = 0;
    let packetsSent = 0, packetsLost = 0;
    let qualityLimit = '';

    stats.forEach(r => {
      if (r.type === 'outbound-rtp' && r.kind === 'video') {
        packetsSent = r.packetsSent || 0;
        if (r.qualityLimitationReason) qualityLimit = r.qualityLimitationReason;
      }
      if (r.type === 'remote-inbound-rtp' && r.kind === 'video') {
        packetsLost = r.packetsLost || 0;
        if (r.roundTripTime) rtt = r.roundTripTime;
      }
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
        if (r.availableOutgoingBitrate) availOut = r.availableOutgoingBitrate;
        if (r.currentRoundTripTime && !rtt) rtt = r.currentRoundTripTime;
      }
    });

    const sentDelta = Math.max(1, packetsSent - abrState.lastPacketsSent);
    const lostDelta = Math.max(0, packetsLost - abrState.lastPacketsLost);
    lossFraction = lostDelta / (sentDelta + lostDelta);
    abrState.lastPacketsSent = packetsSent;
    abrState.lastPacketsLost = packetsLost;

    const tier = TIERS[abrState.tierIdx];
    let nextBitrate = abrState.currentBitrate;
    let action = 'hold';

    if (lossFraction > 0.10 || rtt > 0.6) {
      nextBitrate = Math.floor(abrState.currentBitrate * 0.6);
      abrState.goodTicks = 0;
      action = 'cut';
    } else if (lossFraction > 0.04 || rtt > 0.35) {
      nextBitrate = Math.floor(abrState.currentBitrate * 0.85);
      abrState.goodTicks = 0;
      action = 'down';
    } else {
      abrState.goodTicks++;
      if (abrState.goodTicks >= 3) {
        nextBitrate = Math.floor(abrState.currentBitrate * 1.10);
        action = 'up';
      }
    }

    if (availOut > 0) {
      nextBitrate = Math.min(nextBitrate, Math.floor(availOut * 0.95));
    }

    if (qualityLimit === 'cpu' && abrState.tierIdx > 0) {
      // CPU can't keep up — drop resolution tier outright; bitrate alone won't help.
      await applyTier(abrState.tierIdx - 1);
      abrState.goodTicks = 0;
      action = 'cpu';
    } else if (nextBitrate < tier.maxBitrate * 0.5 && abrState.tierIdx > 0) {
      await applyTier(abrState.tierIdx - 1);
    } else if (nextBitrate > tier.maxBitrate * 1.3 && abrState.tierIdx < TIERS.length - 1 && abrState.goodTicks > 5 && qualityLimit !== 'cpu') {
      await applyTier(abrState.tierIdx + 1);
      abrState.goodTicks = 0;
    } else if (Math.abs(nextBitrate - abrState.currentBitrate) > 20_000) {
      await setBitrate(nextBitrate);
    }

    // Bandwidth probing: every 10 ticks (~20s), if at top tier with clean line,
    // bump bitrate +20% to see if BWE has been underestimating the link.
    abrState.probeTicks++;
    if (abrState.probeTicks >= 10
        && abrState.tierIdx === TIERS.length - 1
        && lossFraction < 0.01
        && qualityLimit !== 'cpu'
        && qualityLimit !== 'bandwidth') {
      const probed = Math.min(6_500_000, Math.floor(abrState.currentBitrate * 1.2));
      if (probed > abrState.currentBitrate) {
        await setBitrate(probed);
        action = 'probe';
      }
      abrState.probeTicks = 0;
    }

    // Adaptive playout delay: tighter on low-latency links, looser on lossy/long-RTT.
    if (rtt) {
      let hint;
      if (rtt < 0.03 && lossFraction < 0.01) hint = 0;       // <30ms, clean → near-zero
      else if (rtt < 0.10)                   hint = 0.05;    // <100ms → 50ms
      else if (rtt < 0.25)                   hint = 0.12;    // <250ms → 120ms
      else                                   hint = 0.20;    // bad link → 200ms
      for (const r of pc.getReceivers()) {
        try { if ('playoutDelayHint' in r) r.playoutDelayHint = hint; } catch {}
      }
    }

    updateAbrBadge(peerId, TIERS[abrState.tierIdx], lossFraction, rtt, abrState.currentBitrate, action);
  }

  abrState.timer = setInterval(tick, 2000);
  applyTier(abrState.tierIdx);

  return {
    stop() { clearInterval(abrState.timer); },
  };
}
