ALTER TABLE traffic_daily ADD COLUMN country TEXT;
ALTER TABLE traffic_daily ADD COLUMN region TEXT;
ALTER TABLE traffic_daily ADD COLUMN city TEXT;
ALTER TABLE traffic_daily ADD COLUMN asn INTEGER;
ALTER TABLE traffic_daily ADD COLUMN organization TEXT;
ALTER TABLE traffic_daily ADD COLUMN observed_at INTEGER NOT NULL DEFAULT 0;
