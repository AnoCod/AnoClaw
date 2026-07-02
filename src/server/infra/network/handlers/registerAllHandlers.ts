// registerAllHandlers — registers all built-in WS message handlers with the router

import type { WsMessageRouter } from '../WsMessageRouter.js';
import { sendMessageHandler } from './SendMessageHandler.js';
import { stopHandler } from './StopHandler.js';
import { pingHandler } from './PingHandler.js';
import { runCommandHandler } from './RunCommandHandler.js';
import { setRunningModeHandler } from './SetRunningModeHandler.js';
import { qualityScoreHandler } from './QualityScoreHandler.js';
import { editorContextHandler } from './EditorContextHandler.js';

export function registerAllWsHandlers(router: WsMessageRouter): void {
  router.on('send_message', sendMessageHandler);
  router.on('stop', stopHandler);
  router.on('ping', pingHandler);
  router.on('run_command', runCommandHandler);
  router.on('set_running_mode', setRunningModeHandler);
  router.on('quality_score', qualityScoreHandler);
  router.on('editor_context', editorContextHandler);
}
