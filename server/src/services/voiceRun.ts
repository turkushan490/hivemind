import type { NodeServices } from '../nodes/index.js';
import { kindOf, writeUnique, type FileUser } from './files.js';
import { speak, transcribe } from './voice.js';
import { addToVoiceDataset, audioFilesOf, buildVoice, characterOf, prepAudio } from './voiceTraining.js';

/** The voice blocks' services for one run: everything acts as (and is owned by) the person who runs it. */
export function voiceServicesFor(user: FileUser): NonNullable<NodeServices['voice']> {
  return {
    character: characterOf,
    files: (question, folder) => audioFilesOf(user, question, folder),
    prep: (files, character, opts) => prepAudio(user, files, character, opts),
    dataset: (dataset, character, clips, progress, signal) => addToVoiceDataset(user, dataset, character, clips, (audio) => transcribe(audio, 'audio/wav', user.id), progress, signal),
    clone: (dataset, name, count) => buildVoice(user, dataset, name, count),
    async speak(text, voice) {
      const out = await speak(text, user.id, { voice, format: 'wav', app: true });
      const ext = out.type.includes('mpeg') ? 'mp3' : 'wav';
      const name = voice.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '');
      const path = writeUnique(`outputs/voice-${name}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`, out.audio, user.id);
      return { file: { path, kind: kindOf(path) }, ...(out.note && { note: out.note }) };
    },
  };
}
