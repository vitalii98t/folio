/// <reference types="vite/client" />

import type { FinmapAgentAPI } from '../main/preload';

declare global {
  interface Window {
    finmapAgent: FinmapAgentAPI;
  }
}
