export interface User {
  id: string
  display_name: string
  email: string
  is_admin: boolean
  created_at: string
}

export interface LabelOption {
  id: string
  project_id: string
  name: string
  color: string | null
  keyboard_shortcut: string | null
  swipe_direction: 'left' | 'right' | 'up' | 'down' | null
  sort_order: number
  created_at: string
}

export interface Project {
  id: string
  name: string
  description: string | null
  created_by: string
  created_at: string
  label_options: LabelOption[]
}

export interface Dataset {
  id: string
  project_id: string
  name: string
  description: string | null
  sample_type: string | null
  total_ions: number
  my_annotation_count: number
  status: 'pending' | 'processing' | 'ready' | 'error'
  error_msg: string | null
  created_at: string
  fluorescence_url: string | null
  fluorescence_outline_url: string | null
}

export interface AnnotationSummary {
  label_option_id: string | null
  label_name: string
  confidence: number | null
}

export interface IonQueueItem {
  id: string
  mz_value: number
  sort_order: number
  image_url: string
  tic_image_url: string | null
  is_starred: boolean
  annotation: AnnotationSummary | null
}

export interface DatasetLabelSummary {
  total: number
  annotated: number
  unannotated: number
  labels: Array<{ label_name: string; count: number; pct: number }>
}

export interface LabelCount {
  label_name: string
  count: number
}

export interface StatsOut {
  total_ions: number
  total_annotated_ions: number
  total_annotations: number
  unique_annotators: number
  label_distribution: LabelCount[]
  per_user: Array<{
    user_id: string
    display_name: string
    annotation_count: number
    label_breakdown: LabelCount[]
  }>
}

export interface GlobalStatsOut {
  total_ions: number
  total_annotations: number
  unique_annotators: number
  label_distribution: LabelCount[]
}
