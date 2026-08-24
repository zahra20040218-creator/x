DELETE FROM platform_config WHERE key = 'required_driver_documents';

DROP INDEX IF EXISTS driver_documents_pending_idx;
DROP INDEX IF EXISTS driver_documents_lookup_idx;
DROP INDEX IF EXISTS driver_documents_driver_type_uq;

DROP TABLE IF EXISTS driver_documents;

DROP TYPE IF EXISTS driver_document_status;
DROP TYPE IF EXISTS driver_document_type;
