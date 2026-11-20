export interface Job {
  id: string;
  source: "ats" | "jobspy";
  company: string;
  title: string;
  location: string;
  remote: boolean;
  url: string;
  postedAt?: string;
  description?: string;
}
