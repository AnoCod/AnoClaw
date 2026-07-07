// registerAllHandlers — registers all built-in WS message handlers with the router

import type { WsMessageRouter } from '../WsMessageRouter.js';
import { sendMessageHandler } from './SendMessageHandler.js';
import { stopHandler } from './StopHandler.js';
import { pingHandler } from './PingHandler.js';
import { runCommandHandler } from './RunCommandHandler.js';
import { setSessionModeHandler } from './SetSessionModeHandler.js';
import { setGoalHandler } from './SetGoalHandler.js';
import { qualityScoreHandler } from './QualityScoreHandler.js';
import { editorContextHandler } from './EditorContextHandler.js';
import { toolConfirmHandler } from './ToolConfirmHandler.js';

export function registerAllWsHandlers(router: WsMessageRouter): void {
  router.on('send_message', sendMessageHandler);
  router.on('stop', stopHandler);
  router.on('ping', pingHandler);
  router.on('run_command', runCommandHandler);
  router.on('set_session_mode', setSessionModeHandler);
  router.on('set_goal', setGoalHandler);
  router.on('quality_score', qualityScoreHandler);
  router.on('editor_context', editorContextHandler);
  router.on('tool_confirm_response', toolConfirmHandler);
}
