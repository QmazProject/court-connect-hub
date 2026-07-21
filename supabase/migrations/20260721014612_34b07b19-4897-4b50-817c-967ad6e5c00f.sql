
CREATE OR REPLACE FUNCTION public.is_tenant(_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = _user_id AND role = 'tenant');
$function$;
