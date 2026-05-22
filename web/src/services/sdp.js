// SDP munging + codec preference. Mirrors static/modules/peer.js helpers.

export function tweakOpusSdp(sdp, musicMode) {
  return sdp.replace(/a=fmtp:(\d+) ([^\r\n]*)/g, (m, pt, params) => {
    const rtpmap = new RegExp(`a=rtpmap:${pt} opus/`, 'i');
    if (!rtpmap.test(sdp)) return m;
    const extras = musicMode
      ? 'minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000'
      : 'minptime=10;useinbandfec=1;usedtx=1;stereo=0;maxaveragebitrate=40000';
    return `a=fmtp:${pt} ${params};${extras}`;
  });
}

export function preferBestCodec(pc) {
  if (!('getCapabilities' in RTCRtpSender)) return;
  const caps = RTCRtpSender.getCapabilities('video');
  if (!caps?.codecs) return;
  const ua = navigator.userAgent || '';
  const isMobile = /Android|iPhone|iPad|iPod/i.test(ua);
  const cores = navigator.hardwareConcurrency || 4;
  const canAv1 = !isMobile && cores >= 8;
  const av1  = canAv1 ? caps.codecs.filter(c => /AV1/i.test(c.mimeType)) : [];
  const vp9  = caps.codecs.filter(c => /VP9/i.test(c.mimeType));
  const h264 = caps.codecs.filter(c => /H264/i.test(c.mimeType));
  const rest = caps.codecs.filter(c => !/AV1|VP9|H264/i.test(c.mimeType));
  const ordered = isMobile
    ? [...h264, ...vp9, ...av1, ...rest]
    : [...av1, ...vp9, ...h264, ...rest];
  if (!ordered.length) return;
  for (const tr of pc.getTransceivers()) {
    if (tr.sender?.track?.kind === 'video' || tr.receiver?.track?.kind === 'video') {
      try { tr.setCodecPreferences(ordered); } catch {}
    }
  }
}
