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
          court_id: number
          created_at: string
          end_time: string
          id: number
          payment_status: string
          start_time: string
          status: string
          user_id: string
        }
        Insert: {
          court_id: number
          created_at?: string
          end_time: string
          id?: never
          payment_status?: string
          start_time: string
          status?: string
          user_id?: string
        }
        Update: {
          court_id?: number
          created_at?: string
          end_time?: string
          id?: never
          payment_status?: string
          start_time?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bookings_court_id_fkey"
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
          description: string | null
          footprint: number
          hourly_rate: number
          id: number
          images: string[]
          is_indoor: boolean
          map_emoji: string | null
          name: string
          operating_hours: Json
          physical_court_id: number
          sport_id: number
          venue_id: number
        }
        Insert: {
          amenities?: string[]
          blocked_dates?: Json
          blocked_hours?: Json
          capacity?: number
          coming_soon?: boolean
          description?: string | null
          footprint?: number
          hourly_rate: number
          id?: never
          images?: string[]
          is_indoor?: boolean
          map_emoji?: string | null
          name: string
          operating_hours?: Json
          physical_court_id: number
          sport_id: number
          venue_id: number
        }
        Update: {
          amenities?: string[]
          blocked_dates?: Json
          blocked_hours?: Json
          capacity?: number
          coming_soon?: boolean
          description?: string | null
          footprint?: number
          hourly_rate?: number
          id?: never
          images?: string[]
          is_indoor?: boolean
          map_emoji?: string | null
          name?: string
          operating_hours?: Json
          physical_court_id?: number
          sport_id?: number
          venue_id?: number
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
          payment_mode: string
          refund_cutoff_hours: number
          timezone: string
        }
        Insert: {
          address: string
          amenities?: string[]
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
          payment_mode?: string
          refund_cutoff_hours?: number
          timezone?: string
        }
        Update: {
          address?: string
          amenities?: string[]
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
          payment_mode?: string
          refund_cutoff_hours?: number
          timezone?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
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
      is_tenant: { Args: { _user_id: string }; Returns: boolean }
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
