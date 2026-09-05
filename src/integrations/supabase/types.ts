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
          refund_method: string | null
          refund_mode: string | null
          refund_reference: string | null
          refund_settled_at: string | null
          refund_settled_by: string | null
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
          refund_method?: string | null
          refund_mode?: string | null
          refund_reference?: string | null
          refund_settled_at?: string | null
          refund_settled_by?: string | null
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
          refund_method?: string | null
          refund_mode?: string | null
          refund_reference?: string | null
          refund_settled_at?: string | null
          refund_settled_by?: string | null
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
      conversation_reads: {
        Row: {
          conversation_id: string
          last_read_at: string
          user_id: string
        }
        Insert: {
          conversation_id: string
          last_read_at?: string
          user_id: string
        }
        Update: {
          conversation_id?: string
          last_read_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_reads_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
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
      court_favorites: {
        Row: {
          court_id: number
          created_at: string
          user_id: string
        }
        Insert: {
          court_id: number
          created_at?: string
          user_id: string
        }
        Update: {
          court_id?: number
          created_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "court_favorites_court_id_fkey"
            columns: ["court_id"]
            isOneToOne: false
            referencedRelation: "courts"
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
          attachment_name: string | null
          attachment_type: string | null
          attachment_url: string | null
          body: string
          conversation_id: string
          created_at: string
          id: string
          read_at: string | null
          reply_to: string | null
          sender_id: string
        }
        Insert: {
          attachment_name?: string | null
          attachment_type?: string | null
          attachment_url?: string | null
          body: string
          conversation_id: string
          created_at?: string
          id?: string
          read_at?: string | null
          reply_to?: string | null
          sender_id: string
        }
        Update: {
          attachment_name?: string | null
          attachment_type?: string | null
          attachment_url?: string | null
          body?: string
          conversation_id?: string
          created_at?: string
          id?: string
          read_at?: string | null
          reply_to?: string | null
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
      notification_outbox: {
        Row: {
          attempts: number
          channel: string
          created_at: string
          id: number
          last_error: string | null
          notification_id: string
          sent_at: string | null
          status: string
          user_id: string
        }
        Insert: {
          attempts?: number
          channel: string
          created_at?: string
          id?: never
          last_error?: string | null
          notification_id: string
          sent_at?: string | null
          status?: string
          user_id: string
        }
        Update: {
          attempts?: number
          channel?: string
          created_at?: string
          id?: never
          last_error?: string | null
          notification_id?: string
          sent_at?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_outbox_notification_id_fkey"
            columns: ["notification_id"]
            isOneToOne: false
            referencedRelation: "notifications"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_preferences: {
        Row: {
          booking_changes_enabled: boolean
          bookings_enabled: boolean
          cancellations_enabled: boolean
          email_enabled: boolean
          messages_enabled: boolean
          new_bookings_enabled: boolean
          payments_enabled: boolean
          push_enabled: boolean
          quiet_hours_end: number | null
          quiet_hours_start: number | null
          refunds_enabled: boolean
          reminders_enabled: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          booking_changes_enabled?: boolean
          bookings_enabled?: boolean
          cancellations_enabled?: boolean
          email_enabled?: boolean
          messages_enabled?: boolean
          new_bookings_enabled?: boolean
          payments_enabled?: boolean
          push_enabled?: boolean
          quiet_hours_end?: number | null
          quiet_hours_start?: number | null
          refunds_enabled?: boolean
          reminders_enabled?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          booking_changes_enabled?: boolean
          bookings_enabled?: boolean
          cancellations_enabled?: boolean
          email_enabled?: boolean
          messages_enabled?: boolean
          new_bookings_enabled?: boolean
          payments_enabled?: boolean
          push_enabled?: boolean
          quiet_hours_end?: number | null
          quiet_hours_start?: number | null
          refunds_enabled?: boolean
          reminders_enabled?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          body: string | null
          dedupe_key: string | null
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
          dedupe_key?: string | null
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
          dedupe_key?: string | null
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
          avatar_url: string | null
          created_at: string
          full_name: string | null
          id: string
          phone: string | null
          role: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id: string
          phone?: string | null
          role?: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          phone?: string | null
          role?: string
          updated_at?: string
        }
        Relationships: []
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          endpoint: string
          last_used_at: string | null
          p256dh: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          auth: string
          created_at?: string
          endpoint: string
          last_used_at?: string | null
          p256dh: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          auth?: string
          created_at?: string
          endpoint?: string
          last_used_at?: string | null
          p256dh?: string
          user_agent?: string | null
          user_id?: string
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
      assistant_query_feedback: {
        Row: {
          id: number
          category: string
          dedupe_key: string
          normalized_query: string
          display_query: string | null
          role: string
          resolved_intent: string | null
          sport_term: string | null
          amenity_term: string | null
          location_term: string | null
          result_count: number | null
          occurrence_count: number
          first_seen_at: string
          last_seen_at: string
          status: string
          resolution_type: string | null
          resolution_id: number | null
          admin_notes: string | null
          reviewed_by: string | null
          reviewed_at: string | null
          truncated: boolean
        }
        Insert: never
        Update: never
        Relationships: []
      }
      assistant_term_mappings: {
        Row: {
          id: number
          kind: string
          term: string
          normalized_term: string
          target_value: string
          target_id: number | null
          active: boolean
          created_by: string | null
          created_at: string
          updated_by: string | null
          updated_at: string
        }
        Insert: never
        Update: never
        Relationships: []
      }
      user_roles: {
        Row: {
          user_id: string
          role: string
          granted_by: string | null
          granted_at: string
          revoked_at: string | null
          revoked_by: string | null
          note: string | null
        }
        Insert: never
        Update: never
        Relationships: []
      }
      admin_audit_log: {
        Row: {
          id: number
          actor_id: string | null
          action: string
          target_type: string | null
          target_id: string | null
          metadata: Json
          created_at: string
        }
        Insert: never
        Update: never
        Relationships: []
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
      claim_notification_outbox: {
        Args: { _limit?: number }
        Returns: {
          attempts: number
          body: string
          channel: string
          id: number
          link: string
          notification_id: string
          title: string
          type: string
          user_id: string
        }[]
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
      get_active_assistant_mappings: {
        Args: Record<PropertyKey, never>
        Returns: { kind: string; normalized_term: string; target_value: string }[]
      }
      record_assistant_feedback: {
        Args: {
          _category: string
          _query: string
          _sport_term?: string | null
          _amenity_term?: string | null
          _location_term?: string | null
          _resolved_intent?: string | null
          _result_count?: number | null
        }
        Returns: undefined
      }
      admin_review_assistant_feedback: {
        Args: { _id: number; _status: string; _notes?: string | null }
        Returns: undefined
      }
      admin_upsert_assistant_mapping: {
        Args: { _kind: string; _term: string; _target_value: string; _feedback_id?: number | null }
        Returns: number
      }
      admin_set_assistant_mapping_active: {
        Args: { _id: number; _active: boolean }
        Returns: undefined
      }
      admin_assistant_insight_stats: {
        Args: { _since?: string | null }
        Returns: { category: string; status: string; signals: number; occurrences: number }[]
      }
      admin_assistant_demand: {
        Args: { _since?: string | null; _limit?: number | null }
        Returns: {
          location_term: string | null
          sport_term: string | null
          searches: number
          last_seen_at: string
        }[]
      }
      is_courthub_admin: {
        Args: Record<PropertyKey, never>
        Returns: boolean
      }
      is_courthub_super_admin: {
        Args: Record<PropertyKey, never>
        Returns: boolean
      }
      claim_initial_role: {
        Args: { _role: string }
        Returns: string
      }
      grant_courthub_admin: {
        Args: { _user_id: string; _role?: string; _note?: string | null }
        Returns: undefined
      }
      revoke_courthub_admin: {
        Args: { _user_id: string; _role?: string }
        Returns: undefined
      }
      list_courthub_admins: {
        Args: Record<PropertyKey, never>
        Returns: {
          user_id: string
          email: string
          full_name: string | null
          role: string
          granted_at: string
          revoked_at: string | null
          last_sign_in_at: string | null
        }[]
      }
      tenant_court_day: {
        Args: { _date: string; _hours?: number[] | null; _now?: string | null }
        Returns: {
          venue_id: number
          venue_name: string
          court_id: number
          court_name: string
          sport: string
          open_hours: number
          booked_hours: number
          held_hours: number
          blocked_hours_count: number
          past_hours: number
          free_hours: number
          free_hour_list: number[]
          booked_hour_list: number[]
          occupancy_pct: number | null
        }[]
      }
      tenant_activity: {
        Args: { _from: string; _to: string }
        Returns: {
          venue_id: number
          venue_name: string
          bookings_created: number
          bookings_starting: number
          cancelled_count: number
          confirmed_count: number
          pending_payment_count: number
          unpaid_count: number
          refund_pending_count: number
          refund_settled_count: number
          paid_amount: number
          pending_amount: number
          refunded_amount: number
        }[]
      }
      courts_availability: {
        Args: { _court_ids: number[]; _from: string; _to: string }
        Returns: {
          court_id: number
          hour_start: string
          remaining: number
          blocked_by_other_sport: boolean
          held_for_payment: boolean
        }[]
      }
      search_available_courts: {
        Args: {
          _date: string
          _hours?: number[] | null
          _min_duration?: number | null
          _sport_slug?: string | null
          _venue_ids?: number[] | null
          _tenant_scope?: boolean | null
          _lat?: number | null
          _lng?: number | null
          _max_km?: number | null
          _min_price?: number | null
          _max_price?: number | null
          _payment?: string | null
          _amenities?: string[] | null
          _order?: string | null
          _now?: string | null
          _limit?: number | null
          _offset?: number | null
        }
        Returns: {
          court_id: number
          venue_id: number
          free_hours: number[]
          free_hour_count: number
          run_start: number
          run_length: number
          period_total: number
          period_rate: number
          distance_km: number | null
          total_matches: number
        }[]
      }
      court_rate_for_hour: {
        Args: { _court_id: number; _ts: string }
        Returns: number
      }
      expire_pending_payment_holds: {
        Args: Record<PropertyKey, never>
        Returns: number
      }
      expire_stale_pending_bookings: {
        Args: { _older_than?: string }
        Returns: number
      }
      finalize_paid_checkout: {
        Args: { _method: string; _payment_id: string; _session_id: string }
        Returns: {
          booking_ids: number[]
          confirmed: boolean
          reason: string
          refund_required: boolean
        }[]
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
      mark_conversation_read: {
        Args: { _conversation_id: string }
        Returns: undefined
      }
      staff_mark_refund_settled: {
        Args: { _booking_ids: number[]; _method?: string; _reference?: string }
        Returns: number
      }
      unread_counts_for_bookings: {
        Args: { _booking_ids: number[] }
        Returns: {
          booking_id: number
          unread: number
        }[]
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
