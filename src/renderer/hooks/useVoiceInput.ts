import { useState, useRef, useCallback } from 'react';

/**
 * Hook for voice input using Web Speech API.
 * Continuous mode — keeps listening until user stops manually.
 */
export function useVoiceInput(onResult: (text: string) => void) {
  const [isListening, setIsListening] = useState(false);
  const [interimText, setInterimText] = useState('');
  const recognitionRef = useRef<any>(null);
  const shouldRestartRef = useRef(false);

  const startListening = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('Speech Recognition not supported');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'uk-UA';
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: any) => {
      let interim = '';
      let final = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          final += transcript;
        } else {
          interim += transcript;
        }
      }

      if (final) {
        onResult(final);
        setInterimText('');
      } else {
        setInterimText(interim);
      }
    };

    recognition.onerror = (event: any) => {
      // "no-speech" is normal — just restart
      if (event.error === 'no-speech' || event.error === 'aborted') {
        return;
      }
      console.warn('Speech recognition error:', event.error);
      shouldRestartRef.current = false;
      setIsListening(false);
      setInterimText('');
    };

    recognition.onend = () => {
      // Auto-restart if user hasn't stopped manually
      if (shouldRestartRef.current) {
        try {
          recognition.start();
        } catch {
          // Already started or other issue
        }
      } else {
        setIsListening(false);
        setInterimText('');
      }
    };

    recognitionRef.current = recognition;
    shouldRestartRef.current = true;

    try {
      recognition.start();
      setIsListening(true);
    } catch {
      console.warn('Failed to start speech recognition');
    }
  }, [onResult]);

  const stopListening = useCallback(() => {
    shouldRestartRef.current = false;
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsListening(false);
    setInterimText('');
  }, []);

  const toggle = useCallback(() => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }, [isListening, startListening, stopListening]);

  return { isListening, interimText, toggle };
}
