export {createHttpAiProvider} from './ai/http.js'
export type {HttpAiProviderOptions} from './ai/http.js'
export {AiSuggestionController,AiError} from './ai/core.js'
import type {AiExtensions} from './ai/types.js'
export type {AiAutocompleteOptions,AiExtensions,AiProvider,AiRequest,AiEvent,AiAction,AiContext,AiSnapshot,AiAdapter,AiAccepted,AiLimits,AiErrorCode} from './ai/types.js'
import type {NodeExtensions} from './extensionTypes.js'
import type {InlineContainerExtensions} from './inline-containers.js'
export type {CustomMarkDefinition,CustomMarkPayload,CustomMarkStyle} from './extensionTypes.js'
export type {NodeExtensions,NodeExtensionDefinition,NodeExtensionService,NodeProperty,ExtensionNodePayload,ExtensionViewContext,NodeConflictChoice,NodeEditInfo,NodeMigrationStep,NodeMigrationPreview,NodeResource,NodeExportFormat,NodeExportSnapshot,NodeExportBlock,NodeExportRun} from './extensionTypes.js'
import type { ReactElement } from 'react'
import type {CommandExtensions} from './commands/types.js'
export type {CommandExtensions,EditorCommand,EditorCommandService,CommandContext,CommandItem,CommandSurface,CommandInvocation,CommandLabel,CommandMenuOverride,EditorProfile} from './commands/types.js'

export type HcdEditorLocale = 'en-US' | 'en-GB' | 'zh-CN' | 'zh-TW' | 'zh-HK'

export type EmbeddedHcdEditorProps = {
  documentId: string
  token: string
  /** Same-origin API prefix, for example /v1/documents. */
  apiUrl: string
  collabUrl: string
  /** Initial locale. Defaults to en-US; accepts en, zh, zh-Hant and supported region tags. */
  locale?: string
  onLocaleChange?: (locale: HcdEditorLocale) => void
  commandExtensions?: CommandExtensions
  nodeExtensions?: NodeExtensions
  inlineContainerExtensions?: InlineContainerExtensions
  aiExtensions?: AiExtensions
  onClose?: () => void
  onError?: (error: Error) => void
}

export declare function EmbeddedHcdEditor(props: EmbeddedHcdEditorProps): ReactElement
