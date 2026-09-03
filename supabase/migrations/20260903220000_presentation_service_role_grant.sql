-- Forward-only grant: allow service_role to execute get_approved_course_presentation_locale
-- alongside authenticated role for backend services and admin previews.

grant execute on function public.get_approved_course_presentation_locale(text, text, public.app_locale)
to service_role;
