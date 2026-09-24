import type { DatabaseMigration } from "./migration"
import initial from "./migration/20260610211500_initial"
import sessionMessageTodoPermission from "./migration/20260611000000_session_message_todo_permission"
import syncEventSequence from "./migration/20260611010000_sync_event_sequence"
import importLegacyDatabases from "./migration/20260611020000_import_legacy_databases"
import importJsonStorage from "./migration/20260611030000_import_json_storage"
import importSyncJson from "./migration/20260611040000_import_sync_json"
import sessionV2Event from "./migration/20260612000000_session_v2_event"
import syncUnify from "./migration/20260630000000_sync_unify"
import workspaceDropEvents from "./migration/20260630000100_workspace_drop_events"
import userExternalSubject from "./migration/20260716000000_user_external_subject"
import sessionEntry from "./migration/20260805000000_session_entry"
import dropSessionV2Event from "./migration/20260805120000_drop_session_v2_event"
import sessionEntryIdOrder from "./migration/20260805130000_session_entry_id_order"
import analyticsStat from "./migration/20260811000000_analytics_stat"
import loopSql from "./migration/20260814000000_loop_sql"
import sessionTimeSuspended from "./migration/20260814010000_session_time_suspended"
import domainSql from "./migration/20260814020000_domain_sql"
import projectSql from "./migration/20260814030000_project_sql"
import analyticsShare from "./migration/20260814040000_analytics_share"
import sessionGoal from "./migration/20260814050000_session_goal"
import backgroundRun from "./migration/20260814060000_background_run"
import routine from "./migration/20260814070000_routine"
import sessionDiff from "./migration/20260814080000_session_diff"
import workspaceJson from "./migration/20260814090000_workspace_json"
import sessionPending from "./migration/20260814100000_session_pending"
import instructionSync from "./migration/20260814110000_instruction_sync"
import sessionLastModel from "./migration/20260816000000_session_last_model"
import sessionDirectoryKey from "./migration/20260824000000_session_directory_key"
import syncEventProjectSeq from "./migration/20260924000000_sync_event_project_seq"

export const migrations = [
  initial,
  sessionMessageTodoPermission,
  syncEventSequence,
  importLegacyDatabases,
  importJsonStorage,
  importSyncJson,
  sessionV2Event,
  syncUnify,
  workspaceDropEvents,
  userExternalSubject,
  sessionEntry,
  dropSessionV2Event,
  sessionEntryIdOrder,
  analyticsStat,
  loopSql,
  sessionTimeSuspended,
  domainSql,
  projectSql,
  analyticsShare,
  sessionGoal,
  backgroundRun,
  routine,
  sessionDiff,
  workspaceJson,
  sessionPending,
  instructionSync,
  sessionLastModel,
  sessionDirectoryKey,
  syncEventProjectSeq,
] satisfies DatabaseMigration.Migration[]
