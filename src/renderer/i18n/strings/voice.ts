import type { StringBundle } from '../index';

const strings: StringBundle = {
  uk: {
    'voice.micDenied': 'Немає доступу до мікрофона. Дозволь його для Folio в налаштуваннях конфіденційності системи.',
    'voice.micNotFound': 'Мікрофон не знайдено. Підключи мікрофон і спробуй ще раз.',
    'voice.micBusy': 'Мікрофон зайнятий іншою програмою.',
    'voice.micStartFailed': 'Не вдалося увімкнути мікрофон: {detail}',
    'voice.recordingInterrupted': 'Запис перервано системою.',
    'voice.transcribeFailed': 'Помилка розпізнавання: {detail}',
    'voice.noSpeech': 'Мікрофон не почув голосу — перевір, чи правильний мікрофон обрано в системі.',
  },
  en: {
    'voice.micDenied': 'No microphone access. Allow it for Folio in your system privacy settings.',
    'voice.micNotFound': 'Microphone not found. Connect a microphone and try again.',
    'voice.micBusy': 'The microphone is in use by another application.',
    'voice.micStartFailed': 'Could not start the microphone: {detail}',
    'voice.recordingInterrupted': 'Recording was interrupted by the system.',
    'voice.transcribeFailed': 'Transcription error: {detail}',
    'voice.noSpeech': 'The microphone picked up no voice — check that the right mic is selected in your system.',
  },
};
export default strings;
