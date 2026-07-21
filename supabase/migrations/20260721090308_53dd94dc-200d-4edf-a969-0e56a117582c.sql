
CREATE POLICY "Authenticated can upload venue images"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'venue-images');

CREATE POLICY "Authenticated can update venue images"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'venue-images')
WITH CHECK (bucket_id = 'venue-images');

CREATE POLICY "Authenticated can delete venue images"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'venue-images');

CREATE POLICY "Authenticated can read venue images"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'venue-images');
