export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      bookings: {
        Row: {
          cancel_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          court_id: number
          created_at: string
          discount_amount: number
          end_time: string
          id: number
          payment_status: string
          refund_mode: string | null
          refund_status: string
          start_time: string
          status: string
          unit_price: number | null
          user_id: string
          voucher_id: string | null
        }
        Insert: {
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          court_id: number
          created_at?: string
          discount_amount?: number
          end_time: string
          id?: never
          payment_status?: string
          refund_mode?: string | null
          refund_status?: string
          start_time: string
          status?: string
          unit_price?: number | null
          user_id?: string
          voucher_id?: string | null
        }
        Update: {
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          court_id?: number
          created_at?: string
          discount_amount?: number
          end_time?: string
          id?: never
          payment_status?: string
          refund_mode?: string | null
          refund_status?: string
          start_time?: string
          status?: string
          unit_price?: number | null
          user_id?: string
          voucher_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bookings_court_id_fkey"
            columns: ["court_id"]
            isOneToOne: false
            referencedRelation: "courts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_voucher_id_fkey"
            columns: ["voucher_id"]
            isOneToOne: false
            referencedRelation: "vouchers"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          booking_id: number
          created_at: string
          id: string
          last_message_at: string | null
          player_id: string
          updated_at: string
          venue_id: number
        }
        Insert: {
          booking_id: number
          created_at?: string
          id?: string
          last_message_at?: string | null
          player_id: string
          updated_at?: string
          venue_id: number
        }
        Update: {
          booking_id?: number
          created_at?: string
          id?: string
          last_message_at?: string | null
          player_id?: string
          updated_at?: string
          venue_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "conversations_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: true
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      court_audit_log: {
        Row: {
          action: string
          actor_id: string | null
          actor_name: string | null
          changes: Json | null
          court_id: number
          created_at: string
          id: number
          venue_id: number
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_name?: string | null
          changes?: Json | null
          court_id: number
          created_at?: string
          id?: number
          venue_id: number
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_name?: string | null
          changes?: Json | null
          court_id?: number
          created_at?: string
          id?: number
          venue_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "court_audit_log_court_id_fkey"
            columns: ["court_id"]
            isOneToOne: false
            referencedRelation: "courts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "court_audit_log_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      court_block_rules: {
        Row: {
          blocked_court_id: number
          court_id: number
          created_at: string
          id: number
          venue_id: number
        }
        Insert: {
          blocked_court_id: number
          court_id: number
          created_at?: string
          id?: number
          venue_id: number
        }
        Update: {
          blocked_court_id?: number
          court_id?: number
          created_at?: string
          id?: number
          venue_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "court_block_rules_blocked_court_id_fkey"
            columns: ["blocked_court_id"]
            isOneToOne: false
            referencedRelation: "courts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "court_block_rules_court_id_fkey"
            columns: ["court_id"]
            isOneToOne: false
            referencedRelation: "courts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "court_block_rules_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      courts: {
        Row: {
          amenities: string[]
          blocked_dates: Json
          blocked_hours: Json
          capacity: number
          coming_soon: boolean
          created_at: string
          description: string | null
          footprint: number
          hourly_rate: number
          id: number
          images: string[]
          inherit_venue_hours: boolean
          is_active: boolean
          is_indoor: boolean
          map_emoji: string | null
          name: string
          operating_hours: Json
          physical_court_id: number
          player_capacity: number | null
          rate_rules: Json
          sport_id: number
          surface_type: string | null
          venue_id: number
          voucher_enabled: boolean
        }
        Insert: {
          amenities?: string[]
          blocked_dates?: Json
          blocked_hours?: Json
          capacity?: number
          coming_soon?: boolean
          created_at?: string
          description?: string | null
          footprint?: number
          hourly_rate: number
          id?: never
          images?: string[]
          inherit_venue_hours?: boolean
          is_active?: boolean
          is_indoor?: boolean
          map_emoji?: string | null
          name: string
          operating_hours?: Json
          physical_court_id: number
          player_capacity?: number | null
          rate_rules?: Json
          sport_id: number
          surface_type?: string | null
          venue_id: number
          voucher_enabled?: boolean
        }
        Update: {
          amenities?: string[]
          blocked_dates?: Json
          blocked_hours?: Json
          capacity?: number
          coming_soon?: boolean
          created_at?: string
          description?: string | null
          footprint?: number
          hourly_rate?: number
          id?: never
          images?: string[]
          inherit_venue_hours?: boolean
          is_active?: boolean
          is_indoor?: boolean
          map_emoji?: string | null
          name?: string
          operating_hours?: Json
          physical_court_id?: number
          player_capacity?: number | null
          rate_rules?: Json
          sport_id?: number
          surface_type?: string | null
          venue_id?: number
          voucher_enabled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "courts_physical_court_id_fkey"
            columns: ["physical_court_id"]
            isOneToOne: false
            referencedRelation: "physical_courts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "courts_sport_id_fkey"
            columns: ["sport_id"]
            isOneToOne: false
            referencedRelation: "sports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "courts_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      map_problems: {
        Row: {
          category: string
          created_at: string
          description: string
          id: string
          latitude: number | null
          longitude: number | null
          user_id: string | null
        }
        Insert: {
          category: string
          created_at?: string
          description: string
          id?: string
          latitude?: number | null
          longitude?: number | null
          user_id?: string | null
        }
        Update: {
          category?: string
          created_at?: string
          description?: string
          id?: string
          latitude?: number | null
          longitude?: number | null
          user_id?: string | null
        }
        Relationships: []
      }
      messages: {
        Row: {
          body: string
          conversation_id: string
          created_at: string
          id: string
          read_at: string | null
          sender_id: string
        }
        Insert: {
          body: string
          conversation_id: string
          created_at?: string
          id?: string
          read_at?: string | null
          sender_id: string
        }
        Update: {
          body?: string
          conversation_id?: string
          created_at?: string
          id?: string
          read_at?: string | null
          sender_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string | null
          booking_id: number | null
          conversation_id: string | null
          created_at: string
          id: string
          link: string | null
          read_at: string | null
          title: string
          type: string
          user_id: string
          venue_id: number | null
        }
        Insert: {
          body?: string | null
          booking_id?: number | null
          conversation_id?: string | null
          created_at?: string
          id?: string
          link?: string | null
          read_at?: string | null
          title: string
          type: string
          user_id: string
          venue_id?: number | null
        }
        Update: {
          body?: string | null
          booking_id?: number | null
          conversation_id?: string | null
          created_at?: string
          id?: string
          link?: string | null
          read_at?: string | null
          title?: string
          type?: string
          user_id?: string
          venue_id?: number | null
        }
        Relationships: []
      }
      physical_courts: {
        Row: {
          created_at: string
          description: string | null
          id: number
          map_emoji: string | null
          name: string
          updated_at: string
          venue_id: number
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: number
          map_emoji?: string | null
          name: string
          updated_at?: string
          venue_id: number
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: number
          map_emoji?: string | null
          name?: string
          updated_at?: string
          venue_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "physical_courts_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          full_name: string | null
          id: string
          phone: string | null
          role: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          full_name?: string | null
          id: string
          phone?: string | null
          role?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          full_name?: string | null
          id?: string
          phone?: string | null
          role?: string
          updated_at?: string
        }
        Relationships: []
      }
      sports: {
        Row: {
          id: number
          name: string
          slug: string
        }
        Insert: {
          id?: never
          name: string
          slug: string
        }
        Update: {
          id?: never
          name?: string
          slug?: string
        }
        Relationships: []
      }
      staff: {
        Row: {
          id: number
          role: string
          user_id: string
          venue_id: number
        }
        Insert: {
          id?: never
          role?: string
          user_id: string
          venue_id: number
        }
        Update: {
          id?: never
          role?: string
          user_id?: string
          venue_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "staff_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      transactions: {
        Row: {
          amount: number
          booking_id: number
          created_at: string
          currency: string
          id: string
          method: string
          mode: string
          paid_at: string | null
          provider: string
          provider_ref: string | null
          raw: Json | null
          refunded_at: string | null
          status: string
          updated_at: string
          user_id: string
          venue_id: number
        }
        Insert: {
          amount: number
          booking_id: number
          created_at?: string
          currency?: string
          id?: string
          method: string
          mode?: string
          paid_at?: string | null
          provider?: string
          provider_ref?: string | null
          raw?: Json | null
          refunded_at?: string | null
          status?: string
          updated_at?: string
          user_id: string
          venue_id: number
        }
        Update: {
          amount?: number
          booking_id?: number
          created_at?: string
          currency?: string
          id?: string
          method?: string
          mode?: string
          paid_at?: string | null
          provider?: string
          provider_ref?: string | null
          raw?: Json | null
          refunded_at?: string | null
          status?: string
          updated_at?: string
          user_id?: string
          venue_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "transactions_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      user_preferences: {
        Row: {
          prefs: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          prefs?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          prefs?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      venue_audit_log: {
        Row: {
          action: string
          actor_id: string | null
          actor_name: string | null
          changes: Json | null
          created_at: string
          id: number
          venue_id: number
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_name?: string | null
          changes?: Json | null
          created_at?: string
          id?: number
          venue_id: number
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_name?: string | null
          changes?: Json | null
          created_at?: string
          id?: number
          venue_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "venue_audit_log_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venues: {
        Row: {
          address: string
          amenities: string[]
          cancellation_notes: string | null
          contact_email: string | null
          contact_phone: string | null
          created_at: string | null
          description: string | null
          downpayment_type: string
          downpayment_value: number
          facility_services: string[]
          fees: Json
          fees_notes: string | null
          food_beverages: string[]
          id: number
          images: string[]
          is_active: boolean
          latitude: number | null
          longitude: number | null
          map_emoji: string | null
          name: string
          operating_hours: Json
          operating_hours_text: string | null
          payment_mode: string
          refund_cutoff_hours: number
          rules: string | null
          timezone: string
        }
        Insert: {
          address: string
          amenities?: string[]
          cancellation_notes?: string | null
          contact_email?: string | null
          contact_phone?: string | null
          created_at?: string | null
          description?: string | null
          downpayment_type?: string
          downpayment_value?: number
          facility_services?: string[]
          fees?: Json
          fees_notes?: string | null
          food_beverages?: string[]
          id?: never
          images?: string[]
          is_active?: boolean
          latitude?: number | null
          longitude?: number | null
          map_emoji?: string | null
          name: string
          operating_hours?: Json
          operating_hours_text?: string | null
          payment_mode?: string
          refund_cutoff_hours?: number
          rules?: string | null
          timezone?: string
        }
        Update: {
          address?: string
          amenities?: string[]
          cancellation_notes?: string | null
          contact_email?: string | null
          contact_phone?: string | null
          created_at?: string | null
          description?: string | null
          downpayment_type?: string
          downpayment_value?: number
          facility_services?: string[]
          fees?: Json
          fees_notes?: string | null
          food_beverages?: string[]
          id?: never
          images?: string[]
          is_active?: boolean
          latitude?: number | null
          longitude?: number | null
          map_emoji?: string | null
          name?: string
          operating_hours?: Json
          operating_hours_text?: string | null
          payment_mode?: string
          refund_cutoff_hours?: number
          rules?: string | null
          timezone?: string
        }
        Relationships: []
      }
      voucher_redemptions: {
        Row: {
          amount_discounted: number
          booking_id: number
          created_at: string
          id: string
          user_id: string
          voucher_id: string
        }
        Insert: {
          amount_discounted?: number
          booking_id: number
          created_at?: string
          id?: string
          user_id: string
          voucher_id: string
        }
        Update: {
          amount_discounted?: number
          booking_id?: number
          created_at?: string
          id?: string
          user_id?: string
          voucher_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "voucher_redemptions_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: true
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "voucher_redemptions_voucher_id_fkey"
            columns: ["voucher_id"]
            isOneToOne: false
            referencedRelation: "vouchers"
            referencedColumns: ["id"]
          },
        ]
      }
      vouchers: {
        Row: {
          code: string
          created_at: string
          created_by: string | null
          discount_type: string
          discount_value: number
          expires_at: string | null
          id: string
          is_active: boolean
          max_uses: number | null
          min_booking_amount: number | null
          notes: string | null
          one_per_user: boolean
          updated_at: string
          venue_id: number
        }
        Insert: {
          code: string
          created_at?: string
          created_by?: string | null
          discount_type: string
          discount_value: number
          expires_at?: string | null
          id?: string
          is_active?: boolean
          max_uses?: number | null
          min_booking_amount?: number | null
          notes?: string | null
          one_per_user?: boolean
          updated_at?: string
          venue_id: number
        }
        Update: {
          code?: string
          created_at?: string
          created_by?: string | null
          discount_type?: string
          discount_value?: number
          expires_at?: string | null
          id?: string
          is_active?: boolean
          max_uses?: number | null
          min_booking_amount?: number | null
          notes?: string | null
          one_per_user?: boolean
          updated_at?: string
          venue_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "vouchers_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      booking_is_active_hold: {
        Args: { _created_at: string; _status: string }
        Returns: boolean
      }
      court_effective_hours: { Args: { _court_id: number }; Returns: Json }
      court_is_open: {
        Args: { _court_id: number; _ts: string }
        Returns: boolean
      }
      court_price_for_hours: {
        Args: { _court_id: number; _hours: string[] }
        Returns: number
      }
      court_rate_for_hour: {
        Args: { _court_id: number; _ts: string }
        Returns: number
      }
      expire_stale_pending_bookings: {
        Args: { _older_than?: string }
        Returns: number
      }
      get_court_availability: {
        Args: { _court_id: number; _from: string; _to: string }
        Returns: {
          blocked_by_other_sport: boolean
          hour_start: string
          remaining: number
        }[]
      }
      get_court_bookings: {
        Args: { _court_id: number; _from: string; _to: string }
        Returns: {
          end_time: string
          start_time: string
        }[]
      }
      get_venue_day_bookings: {
        Args: { _from: string; _to: string; _venue_id: number }
        Returns: {
          court_id: number
          end_time: string
          start_time: string
        }[]
      }
      is_conversation_participant: {
        Args: { _conversation_id: string; _uid: string }
        Returns: boolean
      }
      is_tenant: { Args: { _user_id: string }; Returns: boolean }
      notify_user: {
        Args: {
          _body?: string
          _booking_id?: number
          _conversation_id?: string
          _link?: string
          _title: string
          _type: string
          _user_id: string
          _venue_id?: number
        }
        Returns: string
      }
      parse_hours_window: { Args: { _raw: string }; Returns: number[] }
      preview_voucher: {
        Args: { _amount: number; _code: string; _court_id: number }
        Returns: {
          discount: number
          discount_type: string
          discount_value: number
          ok: boolean
          reason: string
          voucher_id: string
        }[]
      }
      staff_cancel_bookings: {
        Args: { _booking_ids: number[]; _reason: string; _refund_mode: string }
        Returns: number
      }
      staff_mark_refund_settled: {
        Args: { _booking_ids: number[] }
        Returns: number
      }
      venue_has_active_bookings: {
        Args: { _venue_id: number }
        Returns: boolean
      }
      venue_has_any_confirmed_booking: {
        Args: { _venue_id: number }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
