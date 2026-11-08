-- Resolve totals and latest location for only the current page/ranked IPs.
CREATE INDEX idx_traffic_daily_ip_observed
    ON traffic_daily(ip, observed_at DESC, day DESC, direction);
